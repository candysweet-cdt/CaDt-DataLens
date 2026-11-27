// Package netguard 提供 SSRF 防护用的公网地址判定与拨号守卫。
//
// 背景：只做「先用 LookupIP 校验、再交给 net/http 发请求」是不足的——net/http
// 在连接时会重新解析域名（DNS 重绑定 TOCTOU），攻击者可以让第一次解析返回
// 公网地址、连接时返回 127.0.0.1 / 169.254.169.254。Control 在拨号阶段拿到
// **实际要连的 IP**（解析已完成），因此能真正封住这条路。
package netguard

import (
	"context"
	"fmt"
	"net"
	"syscall"
)

// IsPublicIP 报告 ip 是否为可安全访问的公网地址。
// 除环回 / 私网 / 链路本地（含云元数据 169.254.169.254）/ 组播外，
// 还排除若干保留与文档网段，避免被当作跳板。
func IsPublicIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return false
	}
	if v4 := ip.To4(); v4 != nil {
		switch {
		case v4[0] == 0:
			return false
		case v4[0] == 100 && v4[1]&0xC0 == 64: // 100.64.0.0/10
			return false
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 0: // 192.0.0.0/24
			return false
		case v4[0] == 192 && v4[1] == 0 && v4[2] == 2: // 192.0.2.0/24
			return false
		case v4[0] == 198 && (v4[1] == 18 || v4[1] == 19): // 198.18.0.0/15
			return false
		case v4[0] == 198 && v4[1] == 51 && v4[2] == 100: // 198.51.100.0/24
			return false
		case v4[0] == 203 && v4[1] == 0 && v4[2] == 113: // 203.0.113.0/24
			return false
		case v4[0] >= 240:
			return false
		}
		return true
	}
	if len(ip) == net.IPv6len && ip[0] == 0x20 && ip[1] == 0x01 && ip[2] == 0x0d && ip[3] == 0xb8 {
		return false // 2001:db8::/32
	}
	return true
}

// Control 是 net.Dialer.Control 的实现：连接建立前校验实际目标 IP。
// 仅对直连有效；走代理时拨号目标是代理本身，调用方需自行决定是否挂载。
func Control(network, address string, _ syscall.RawConn) error {
	switch network {
	case "tcp", "tcp4", "tcp6":
	default:
		return nil
	}
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return err
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil // 非 IP 字面量（dial 阶段理论上不会出现），交给系统
	}
	if !IsPublicIP(ip) {
		return fmt.Errorf("拒绝连接非公网地址：%s", host)
	}
	return nil
}

// Dialer 返回带公网限制的拨号器，可直接赋给 http.Transport.DialContext。
// 超时由调用方按需覆盖（此处只设 Control）。
func Dialer() *net.Dialer {
	return &net.Dialer{Control: Control}
}

// LookupPublicIPs 解析域名并确认全部地址都是公网地址；任一命中保留地址即报错。
// 这是「连接前预检」，与 Control（连接时校验）配合使用。
func LookupPublicIPs(ctx context.Context, host string) ([]net.IP, error) {
	ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("域名没有可用地址：%s", host)
	}
	for _, ip := range ips {
		if !IsPublicIP(ip) {
			return nil, fmt.Errorf("只允许访问公网地址（%s 解析到内网或保留地址）", host)
		}
	}
	return ips, nil
}
