//go:build windows

package sandbox

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"datalens/internal/envvars"
	"golang.org/x/sys/windows"
)

// Win32 绑定：x/sys 没导出的三个 ACL/令牌过程走 LazyProc，其余用现成封装。
var (
	modAdvapi32               = windows.NewLazySystemDLL("advapi32.dll")
	procCreateRestrictedToken = modAdvapi32.NewProc("CreateRestrictedToken")
	procSetEntriesInAclW      = modAdvapi32.NewProc("SetEntriesInAclW")
	procGetNamedSecurityInfoW = modAdvapi32.NewProc("GetNamedSecurityInfoW")
	procInitializeAcl         = modAdvapi32.NewProc("InitializeAcl")
	procAddMandatoryAce       = modAdvapi32.NewProc("AddMandatoryAce")
	procAddAce                = modAdvapi32.NewProc("AddAce")
)

const (
	// detachedProcess 是唯一可用的启动形态（见方案 §8.1）：受限令牌下
	// CREATE_NO_WINDOW / CREATE_NEW_CONSOLE / HideWindow 一律 0xC0000142，
	// 只有「不建控制台」或「继承已存在的控制台」能活。
	detachedProcess = 0x00000008

	disableMaxPrivilege = 0x00000001
	writeRestricted     = 0x00000008

	tokenAssignPrimary = 0x0001
	tokenDuplicate     = 0x0002
	tokenQuery         = 0x0008
	tokenAdjustDefault = 0x0080

	// grantMask = (FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE
	// WRITE_DAC / WRITE_OWNER 故意排除：受限子进程不能改 DACL 或夺取所有权。
	grantMask       = 0x00110156
	fileDeleteChild = 0x0040

	subContainersAndObjectsInherit = 0x00000003
	containerInheritACE            = 0x00000002

	accessAllowedACEType          = 0
	accessDeniedACEType           = 1
	systemMandatoryLabelACEType   = 0x11
	systemMandatoryLabelNoWriteUp = 0x00000001

	aclRevision          = 2
	lptr                 = 0x0040
	mandatoryACEOverhead = 8 // ACE 头 4 + 掩码 4

	seFileObject             = 1
	ownerSecurityInformation = 0x00000001
	daclSecurityInformation  = 0x00000004
	labelSecurityInformation = 0x00000010
)

// Sandbox 是一次执行用的受限进程环境：令牌 + 写根授权 + 私有 temp + Job。
// 一次执行一个实例，用完必须 Close（撤 temp 授权、杀进程树、关令牌）。
type Sandbox struct {
	policy       Policy
	workspace    string
	tempDir      string
	workspaceSID *windows.SID
	tempSID      *windows.SID
	token        windows.Token
	job          windows.Handle
	tempGranted  bool

	once     sync.Once
	closeErr error
}

// New 建令牌、落授权、建 Job；任一步失败即返回 ErrUnavailable，调用方必须拒绝执行。
func New(p Policy) (*Sandbox, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	s := &Sandbox{policy: p}

	// 工作区：规范化到物理路径（同一目录的两种拼法必须派生同一个 SID）。
	if p.Mode == WorkspaceWrite {
		root, err := canonicalDir(p.WorkspaceRoot, "写根")
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
		}
		s.workspace = root
	}
	if strings.TrimSpace(p.TempDir) != "" {
		temp, err := canonicalDir(p.TempDir, "临时目录")
		if err != nil {
			return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
		}
		if s.workspace != "" && (containsDir(s.workspace, temp) || containsDir(temp, s.workspace)) {
			return nil, fmt.Errorf("%w: 私有 temp 与写根必须互不包含（workspace=%s temp=%s）", ErrUnavailable, s.workspace, temp)
		}
		s.tempDir = temp
	}

	// SID：workspace 由路径确定（同目录跨会话复用同一授权），temp 加域分离后缀。
	if s.workspace != "" {
		sid, err := parseSID(workspaceWriteSIDString(s.workspace))
		if err != nil {
			return nil, fmt.Errorf("%w: 派生 workspace SID: %v", ErrUnavailable, err)
		}
		s.workspaceSID = sid
	}
	if s.tempDir != "" {
		sid, err := parseSID(tempWriteSIDString(s.tempDir))
		if err != nil {
			return nil, fmt.Errorf("%w: 派生 temp SID: %v", ErrUnavailable, err)
		}
		s.tempSID = sid
	}

	lowSID, err := windows.CreateWellKnownSid(windows.WinLowLabelSid)
	if err != nil {
		return nil, fmt.Errorf("%w: CreateWellKnownSid(Low): %v", ErrUnavailable, err)
	}
	worldSID, err := windows.CreateWellKnownSid(windows.WinWorldSid)
	if err != nil {
		return nil, fmt.Errorf("%w: CreateWellKnownSid(Everyone): %v", ErrUnavailable, err)
	}

	token, err := newRestrictedToken(p.Mode, s.workspaceSID, s.tempSID, worldSID, lowSID)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	s.token = token

	// 授权：read-only 一个都不给；workspace-write 给写根（standing）与 temp（可撤销）。
	if p.Mode == WorkspaceWrite && s.workspaceSID != nil {
		if err := grantWrite(s.workspace, s.workspaceSID, lowSID, worldSID); err != nil {
			_ = s.Close()
			return nil, fmt.Errorf("%w: 授权写根 %s: %v%s", ErrUnavailable, s.workspace, err, diagnoseGrantFailure(s.workspace))
		}
		if s.tempSID != nil && s.tempDir != "" {
			if err := grantWrite(s.tempDir, s.tempSID, lowSID, worldSID); err != nil {
				_ = s.Close()
				return nil, fmt.Errorf("%w: 授权临时目录 %s: %v%s", ErrUnavailable, s.tempDir, err, diagnoseGrantFailure(s.tempDir))
			}
			s.tempGranted = true
		}
	}

	job, err := newKillOnCloseJob()
	if err != nil {
		_ = s.Close()
		return nil, fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	s.job = job
	return s, nil
}

// Enforcement 如实报告完整度（永远是 partial，见方案 §3.3-8）。
func (s *Sandbox) Enforcement() string { return EnforcementPartial }

// TempDir 返回本次执行实际使用的私有临时目录（未授权时为空）。
func (s *Sandbox) TempDir() string { return s.tempDir }

// Configure 把令牌与启动标志装到 cmd 上。
//
// 会整体替换 SysProcAttr：调用方**不得**再设 HideWindow / CreationFlags，也不要在
// 沙箱档调用 executil.HideCommandWindow——那正是必死的 0xC0000142 组合。
func (s *Sandbox) Configure(cmd *exec.Cmd) error {
	flags := uintptr(detachedProcess)
	if s.policy.ShareConsole {
		if err := ensureHiddenConsole(); err != nil {
			return err
		}
		// 0 = 继承宿主控制台（已隐藏），不新建也不禁用。
		flags = 0
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Token:         syscall.Token(s.token),
		CreationFlags: uint32(flags),
	}
	if s.tempDir != "" {
		base := cmd.Env
		if base == nil {
			base = os.Environ()
		}
		cmd.Env = s.Env(base)
	}
	return nil
}

var (
	consoleOnce sync.Once
	consoleErr  error
)

// ensureHiddenConsole 给宿主进程分配一个控制台并立刻隐藏，供受限子进程继承。
// PowerShell 5.1 在没有控制台时会静默退出（实测 exit 0 但什么都不执行）。
func ensureHiddenConsole() error {
	consoleOnce.Do(func() {
		kernel32 := windows.NewLazySystemDLL("kernel32.dll")
		ok, _, allocErr := kernel32.NewProc("AllocConsole").Call()
		if ok == 0 {
			// 已有控制台也算成功（例如被终端拉起时）。
			if errno, isErrno := allocErr.(windows.Errno); isErrno && errno == windows.ERROR_ACCESS_DENIED {
				return
			}
			consoleErr = fmt.Errorf("AllocConsole: %v", allocErr)
			return
		}
		if hwnd, _, _ := kernel32.NewProc("GetConsoleWindow").Call(); hwnd != 0 {
			windows.NewLazySystemDLL("user32.dll").NewProc("ShowWindow").Call(hwnd, 0 /* SW_HIDE */)
		}
	})
	return consoleErr
}

// Env 在给定环境块上重写 TMP/TEMP 指向私有临时目录（大小写无关，对齐 ZCode 合同）。
func (s *Sandbox) Env(base []string) []string {
	if s.tempDir == "" {
		return base
	}
	base = envvars.SanitizeChildEnv(base) // 应用私有变量（宿主 MCP 凭据等）不进沙箱
	out := make([]string, 0, len(base)+2)
	for _, kv := range base {
		key := kv
		if i := strings.IndexByte(kv, '='); i >= 0 {
			key = kv[:i]
		}
		switch strings.ToUpper(key) {
		case "TMP", "TEMP":
			continue
		}
		out = append(out, kv)
	}
	return append(out, "TMP="+s.tempDir, "TEMP="+s.tempDir)
}

// Start 配置并启动子进程，然后把它放进 kill-on-close 的 Job。
func (s *Sandbox) Start(cmd *exec.Cmd) error {
	if s.token == 0 {
		return fmt.Errorf("%w: 沙箱已关闭", ErrUnavailable)
	}
	if err := s.Configure(cmd); err != nil {
		return fmt.Errorf("%w: %v", ErrUnavailable, err)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	if s.job != 0 && cmd.Process != nil {
		handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
		if err != nil {
			_ = cmd.Process.Kill()
			return fmt.Errorf("%w: OpenProcess: %v", ErrUnavailable, err)
		}
		defer windows.CloseHandle(handle)
		if err := windows.AssignProcessToJobObject(s.job, handle); err != nil {
			// Job 是「顺带杀整棵树」的增强，不是安全边界。有些 shell（例如商店版
			// pwsh）本身已在别的 Job 里，无法再加，这里不阻断执行——停止仍走
			// procctl 的 taskkill 树杀。
			_ = err
		}
	}
	return nil
}

// Run 是 Start + Wait 的组合。
func (s *Sandbox) Run(cmd *exec.Cmd) error {
	if err := s.Start(cmd); err != nil {
		return err
	}
	return cmd.Wait()
}

// Close 终止进程树、撤销 temp 授权、关闭令牌。写根的 standing 授权**不撤销**
// （同 dsh：它是跨会话复用缓存，撤销会让下次重新传播整棵树）。
func (s *Sandbox) Close() error {
	s.once.Do(func() {
		var problems []string
		if s.job != 0 {
			if err := windows.TerminateJobObject(s.job, 1); err != nil {
				problems = append(problems, "TerminateJobObject: "+err.Error())
			}
			windows.CloseHandle(s.job)
			s.job = 0
		}
		if s.tempGranted && s.tempSID != nil && s.tempDir != "" {
			if err := revokeWrite(s.tempDir, s.tempSID); err != nil {
				problems = append(problems, "撤销 temp 授权: "+err.Error())
			}
			// revokeWrite 只撤能力 SID 的 allow ACE，Everyone 的 FILE_DELETE_CHILD
			// deny 还留在 temp 上（并继承给子项）。宿主随后 os.RemoveAll 会被拒、错误
			// 又常被 `_ =` 吞掉，私有 temp 就长期泄漏——所以这里把三样痕迹一并清掉。
			if _, err := Revoke(s.tempDir); err != nil {
				problems = append(problems, "清理 temp ACL: "+err.Error())
			}
			s.tempGranted = false
		}
		if s.token != 0 {
			if err := s.token.Close(); err != nil {
				problems = append(problems, "关闭令牌: "+err.Error())
			}
			s.token = 0
		}
		if len(problems) > 0 {
			s.closeErr = fmt.Errorf("sandbox: 清理失败：%s", strings.Join(problems, "；"))
		}
	})
	return s.closeErr
}

// ---------- 令牌 ----------

func newRestrictedToken(mode Mode, workspaceSID, tempSID, worldSID, lowSID *windows.SID) (windows.Token, error) {
	var current windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(),
		tokenQuery|tokenDuplicate|tokenAdjustDefault|tokenAssignPrimary, &current); err != nil {
		return 0, fmt.Errorf("OpenProcessToken: %w", err)
	}
	defer current.Close()

	logonSID, keepAlive, err := logonSIDOf(current)
	if err != nil {
		return 0, err
	}

	// restricting 列表：read-only 只有保活组；workspace-write 追加能力 SID。
	sids := []windows.SIDAndAttributes{
		{Sid: logonSID, Attributes: 0},
		{Sid: worldSID, Attributes: 0},
	}
	if mode == WorkspaceWrite {
		if workspaceSID == nil {
			return 0, fmt.Errorf("workspace-write 缺少 workspace SID")
		}
		sids = append(sids, windows.SIDAndAttributes{Sid: workspaceSID, Attributes: 0})
		if tempSID != nil {
			sids = append(sids, windows.SIDAndAttributes{Sid: tempSID, Attributes: 0})
		}
	}

	var restricted windows.Token
	r, _, callErr := procCreateRestrictedToken.Call(
		uintptr(current),
		uintptr(disableMaxPrivilege|writeRestricted),
		0, 0,
		0, 0,
		uintptr(len(sids)), uintptr(unsafe.Pointer(&sids[0])),
		uintptr(unsafe.Pointer(&restricted)),
	)
	if r == 0 {
		return 0, fmt.Errorf("CreateRestrictedToken: %v", callErr)
	}
	// keepAlive 必须活到 CreateRestrictedToken 返回（logonSID 指向它的内存）。
	_ = keepAlive

	label := tokenMandatoryLabel{Label: windows.SIDAndAttributes{Sid: lowSID, Attributes: windows.SE_GROUP_INTEGRITY}}
	if err := windows.SetTokenInformation(restricted, windows.TokenIntegrityLevel,
		(*byte)(unsafe.Pointer(&label)), uint32(unsafe.Sizeof(label))); err != nil {
		restricted.Close()
		return 0, fmt.Errorf("SetTokenInformation(TokenIntegrityLevel): %w", err)
	}

	// 默认 DACL 必须补一条 restricting SID 的全权 ACE：受限令牌不继承任何
	// restricting SID，新建对象（管道、共享内存）的 write 二次检查会全挂。
	// 优先用 temp SID，避免同一会话新建的对象带上共享的 workspace 能力。
	defaultSID := tempSID
	if defaultSID == nil {
		defaultSID = workspaceSID
	}
	if defaultSID == nil {
		defaultSID = worldSID
	}
	if err := grantTokenDefaultDACL(restricted, defaultSID); err != nil {
		restricted.Close()
		return 0, fmt.Errorf("默认 DACL 授权: %w", err)
	}
	return restricted, nil
}

type tokenMandatoryLabel struct {
	Label windows.SIDAndAttributes
}

// logonSIDOf 取登录会话 SID，并返回承载它的缓冲（调用方需保活到令牌创建之后）。
func logonSIDOf(token windows.Token) (*windows.SID, []byte, error) {
	var needed uint32
	_ = windows.GetTokenInformation(token, windows.TokenGroups, nil, 0, &needed)
	if needed == 0 {
		return nil, nil, fmt.Errorf("GetTokenInformation(TokenGroups): 尺寸查询失败")
	}
	buf := make([]byte, needed)
	if err := windows.GetTokenInformation(token, windows.TokenGroups, &buf[0], needed, &needed); err != nil {
		return nil, nil, fmt.Errorf("GetTokenInformation(TokenGroups): %w", err)
	}
	groups := (*windows.Tokengroups)(unsafe.Pointer(&buf[0]))
	list := unsafe.Slice(&groups.Groups[0], int(groups.GroupCount))
	for i := range list {
		if list[i].Sid == nil {
			continue
		}
		if uint32(list[i].Attributes)&uint32(windows.SE_GROUP_LOGON_ID) == uint32(windows.SE_GROUP_LOGON_ID) {
			return list[i].Sid, buf, nil
		}
	}
	return nil, nil, fmt.Errorf("令牌里没有登录会话 SID（TokenGroups 共 %d 项）", groups.GroupCount)
}

// grantTokenDefaultDACL 往令牌默认 DACL 合并一条全权 ACE（对齐 dsh 的同名修复）。
func grantTokenDefaultDACL(token windows.Token, sid *windows.SID) error {
	var needed uint32
	_ = windows.GetTokenInformation(token, windows.TokenDefaultDacl, nil, 0, &needed)
	if needed == 0 {
		return fmt.Errorf("TokenDefaultDacl 尺寸查询失败")
	}
	buf := make([]byte, needed)
	if err := windows.GetTokenInformation(token, windows.TokenDefaultDacl, &buf[0], needed, &needed); err != nil {
		return err
	}
	current := *(**windows.ACL)(unsafe.Pointer(&buf[0]))
	entry := windows.EXPLICIT_ACCESS{
		AccessPermissions: windows.GENERIC_ALL,
		AccessMode:        windows.GRANT_ACCESS,
		Inheritance:       0,
		Trustee:           trusteeOf(sid),
	}
	var merged *windows.ACL
	r, _, callErr := procSetEntriesInAclW.Call(
		1, uintptr(unsafe.Pointer(&entry)), uintptr(unsafe.Pointer(current)), uintptr(unsafe.Pointer(&merged)),
	)
	if r != 0 {
		return fmt.Errorf("SetEntriesInAclW(默认 DACL): %v", winErr(r, callErr))
	}
	defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(merged))))
	info := struct{ DefaultDacl *windows.ACL }{DefaultDacl: merged}
	return windows.SetTokenInformation(token, windows.TokenDefaultDacl,
		(*byte)(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)))
}

// ---------- ACL ----------

type securitySnapshot struct {
	dacl *windows.ACL
	sacl *windows.ACL
	sd   uintptr
}

func readSecurity(path string) (*securitySnapshot, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	var dacl, sacl *windows.ACL
	var sd uintptr
	r, _, callErr := procGetNamedSecurityInfoW.Call(
		uintptr(unsafe.Pointer(name)), seFileObject,
		daclSecurityInformation|labelSecurityInformation,
		0, 0,
		uintptr(unsafe.Pointer(&dacl)), uintptr(unsafe.Pointer(&sacl)),
		uintptr(unsafe.Pointer(&sd)),
	)
	if r != 0 {
		return nil, fmt.Errorf("GetNamedSecurityInfoW(%s): %v", path, winErr(r, callErr))
	}
	return &securitySnapshot{dacl: dacl, sacl: sacl, sd: sd}, nil
}

// release 释放描述符（ACL 指针在描述符内存里，只能整体释放一次）。
func (s *securitySnapshot) release() {
	if s.sd != 0 {
		windows.LocalFree(windows.Handle(s.sd))
		s.sd = 0
		s.dacl, s.sacl = nil, nil
	}
}

// walkACEs 逐个访问 ACE：类型、标志、掩码、内联 SID。返回 false 提前结束。
func walkACEs(acl *windows.ACL, fn func(aceType, aceFlags byte, mask uint32, sid *windows.SID) bool) {
	if acl == nil {
		return
	}
	base := unsafe.Pointer(acl)
	aclSize := uintptr(*(*uint16)(unsafe.Add(base, 2)))
	count := int(*(*uint16)(unsafe.Add(base, 4)))
	if aclSize < 8 {
		return
	}
	offset := uintptr(8)
	for i := 0; i < count; i++ {
		if offset+4 > aclSize {
			return
		}
		aceSize := uintptr(*(*uint16)(unsafe.Add(base, offset+2)))
		if aceSize < 8 || offset+aceSize > aclSize {
			return
		}
		aceType := *(*byte)(unsafe.Add(base, offset))
		aceFlags := *(*byte)(unsafe.Add(base, offset+1))
		mask := *(*uint32)(unsafe.Add(base, offset+4))
		sid := (*windows.SID)(unsafe.Add(base, offset+8))
		if !fn(aceType, aceFlags, mask, sid) {
			return
		}
		offset += aceSize
	}
}

func hasACE(acl *windows.ACL, wantType, wantFlags byte, wantMask uint32, want *windows.SID) bool {
	found := false
	walkACEs(acl, func(aceType, aceFlags byte, mask uint32, sid *windows.SID) bool {
		if aceType == wantType && aceFlags == wantFlags && mask == wantMask && sid != nil && windows.EqualSid(sid, want) {
			found = true
			return false
		}
		return true
	})
	return found
}

func trusteeOf(sid *windows.SID) windows.TRUSTEE {
	return windows.TRUSTEE{
		MultipleTrusteeOperation: windows.NO_MULTIPLE_TRUSTEE,
		TrusteeForm:              windows.TRUSTEE_IS_SID,
		TrusteeType:              windows.TRUSTEE_IS_UNKNOWN,
		TrusteeValue:             windows.TrusteeValueFromSID(sid),
	}
}

// buildLowLabelACL 造一个只含 Low no-write-up 标签的 ACL（继承到容器与对象）。
// 内存用 Go 缓冲：AddMandatoryAce 只是往里写，调用方拿住返回的切片直到
// SetNamedSecurityInfo 返回即可（它会把 ACL 复制走），不需要 LocalFree。
func buildLowLabelACL(low *windows.SID) ([]byte, *windows.ACL, error) {
	sidLen := int(windows.GetLengthSid(low))
	if sidLen == 0 {
		return nil, nil, fmt.Errorf("GetLengthSid(Low) 失败")
	}
	buf := make([]byte, 8+mandatoryACEOverhead+sidLen)
	acl := (*windows.ACL)(unsafe.Pointer(&buf[0]))
	if r, _, callErr := procInitializeAcl.Call(uintptr(unsafe.Pointer(acl)), uintptr(len(buf)), aclRevision); r == 0 {
		return nil, nil, fmt.Errorf("InitializeAcl: %v", winErr(r, callErr))
	}
	if r, _, callErr := procAddMandatoryAce.Call(
		uintptr(unsafe.Pointer(acl)), aclRevision, subContainersAndObjectsInherit,
		systemMandatoryLabelNoWriteUp, uintptr(unsafe.Pointer(low)),
	); r == 0 {
		return nil, nil, fmt.Errorf("AddMandatoryAce: %v", winErr(r, callErr))
	}
	return buf, acl, nil
}

// grantWrite 在一次 SetNamedSecurityInfoW 里落三件事：能力 SID 的 allow ACE、
// Everyone 的 FILE_DELETE_CHILD deny（只继承到容器）、Low no-write-up 标签。
// 三条都已存在则跳过——SetNamedSecurityInfoW 会 eager 传播整棵树，大树几十秒。
func grantWrite(path string, sid, low, world *windows.SID) error {
	return withPathLock(path, func() error {
		snapshot, err := readSecurity(path)
		if err != nil {
			return err
		}
		if hasACE(snapshot.dacl, accessAllowedACEType, subContainersAndObjectsInherit, grantMask, sid) &&
			hasACE(snapshot.dacl, accessDeniedACEType, containerInheritACE, fileDeleteChild, world) &&
			hasACE(snapshot.sacl, systemMandatoryLabelACEType, subContainersAndObjectsInherit, systemMandatoryLabelNoWriteUp, low) {
			snapshot.release()
			return nil
		}

		labelBuf, label, err := buildLowLabelACL(low)
		if err != nil {
			snapshot.release()
			return err
		}
		_ = labelBuf // 保活到 SetNamedSecurityInfo 返回

		entries := []windows.EXPLICIT_ACCESS{
			{
				AccessPermissions: fileDeleteChild,
				AccessMode:        windows.DENY_ACCESS,
				Inheritance:       containerInheritACE,
				Trustee:           trusteeOf(world),
			},
			{
				AccessPermissions: grantMask,
				AccessMode:        windows.GRANT_ACCESS,
				Inheritance:       subContainersAndObjectsInherit,
				Trustee:           trusteeOf(sid),
			},
		}
		var merged *windows.ACL
		r, _, callErr := procSetEntriesInAclW.Call(
			uintptr(len(entries)), uintptr(unsafe.Pointer(&entries[0])),
			uintptr(unsafe.Pointer(snapshot.dacl)), uintptr(unsafe.Pointer(&merged)),
		)
		if r != 0 {
			snapshot.release()
			return fmt.Errorf("SetEntriesInAclW(%s): %v", path, winErr(r, callErr))
		}
		defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(merged))))
		// 描述符必须在 apply 之前释放：merged 已独立分配，旧 ACL 随描述符一起去。
		snapshot.release()
		return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
			windows.SECURITY_INFORMATION(daclSecurityInformation|labelSecurityInformation),
			nil, nil, merged, label)
	})
}

// revokeWrite 撤掉能力 SID 的 ACE（REVOKE_ACCESS 合并，保留其它条目）。
// 保留 Low 标签：temp 目录随后会被删除，标签跟着走；写根的标签本就是 standing。
func revokeWrite(path string, sid *windows.SID) error {
	return withPathLock(path, func() error {
		snapshot, err := readSecurity(path)
		if err != nil {
			return err
		}
		if snapshot.dacl == nil {
			snapshot.release()
			return nil
		}
		entry := windows.EXPLICIT_ACCESS{
			AccessPermissions: 0,
			AccessMode:        windows.REVOKE_ACCESS,
			Inheritance:       0,
			Trustee:           trusteeOf(sid),
		}
		var merged *windows.ACL
		r, _, callErr := procSetEntriesInAclW.Call(
			1, uintptr(unsafe.Pointer(&entry)),
			uintptr(unsafe.Pointer(snapshot.dacl)), uintptr(unsafe.Pointer(&merged)),
		)
		if r != 0 {
			snapshot.release()
			return fmt.Errorf("SetEntriesInAclW(%s): %v", path, winErr(r, callErr))
		}
		defer windows.LocalFree(windows.Handle(uintptr(unsafe.Pointer(merged))))
		snapshot.release()
		return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
			windows.SECURITY_INFORMATION(daclSecurityInformation), nil, nil, merged, nil)
	})
}

// withPathLock 用 per-path 文件锁串行化 get-merge-set，两个沙箱实例不会互相覆盖 ACE。
func withPathLock(path string, fn func() error) error {
	lockDir := filepath.Join(os.TempDir(), "cadt-acl-locks")
	if err := os.MkdirAll(lockDir, 0o755); err != nil {
		return fmt.Errorf("建锁目录: %w", err)
	}
	sum := sha256.Sum256([]byte(strings.ToLower(path)))
	lockPath := filepath.Join(lockDir, hex.EncodeToString(sum[:8])+".lock")
	name, err := windows.UTF16PtrFromString(lockPath)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(name,
		windows.GENERIC_READ|windows.GENERIC_WRITE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return fmt.Errorf("CreateFile(%s): %w", lockPath, err)
	}
	defer windows.CloseHandle(handle)
	overlapped := new(windows.Overlapped)
	if err := windows.LockFileEx(handle, windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped); err != nil {
		return fmt.Errorf("LockFileEx(%s): %w", lockPath, err)
	}
	defer windows.UnlockFileEx(handle, 0, 1, 0, overlapped)
	return fn()
}

// ---------- 残留清理（撤销 standing 授权） ----------

// Scan 报告目录上残留的沙箱授权痕迹；只读，不改任何东西。
func Scan(root string) (*GrantState, error) {
	dir, err := canonicalDir(root, "目录")
	if err != nil {
		return nil, err
	}
	sidStr := workspaceWriteSIDString(dir)
	sid, err := parseSID(sidStr)
	if err != nil {
		return nil, err
	}
	low, err := windows.CreateWellKnownSid(windows.WinLowLabelSid)
	if err != nil {
		return nil, err
	}
	world, err := windows.CreateWellKnownSid(windows.WinWorldSid)
	if err != nil {
		return nil, err
	}
	sec, err := readSecurity(dir)
	if err != nil {
		return nil, err
	}
	defer sec.release()
	return &GrantState{
		Root:         dir,
		WorkspaceSID: sidStr,
		Granted:      hasACE(sec.dacl, accessAllowedACEType, subContainersAndObjectsInherit, grantMask, sid),
		DenyPresent:  hasACE(sec.dacl, accessDeniedACEType, containerInheritACE, fileDeleteChild, world),
		Labeled:      hasACE(sec.sacl, systemMandatoryLabelACEType, subContainersAndObjectsInherit, systemMandatoryLabelNoWriteUp, low),
	}, nil
}

// Revoke 撤掉本包在该目录留下的三样痕迹：能力 SID 的 allow ACE、Everyone 的
// FILE_DELETE_CHILD deny、Low 完整性标签（后者在没有其它能力授权时才清）。
//
// 只删「完全匹配我们签名」的条目，其余 ACE 原样保留——用户的显式授权、继承来的
// 条目、其它工具的 deny 都不动。删除继承型 ACE 后由系统把变更传播给子项。
//
// 这是 `icacls` 做不到的事：能力 SID 是派生出来的 S-1-4-x-y，解析失败（1332），
// 所以清理只能走本包。
func Revoke(root string) (*GrantState, error) {
	dir, err := canonicalDir(root, "目录")
	if err != nil {
		return nil, err
	}
	sid, err := parseSID(workspaceWriteSIDString(dir))
	if err != nil {
		return nil, err
	}
	low, err := windows.CreateWellKnownSid(windows.WinLowLabelSid)
	if err != nil {
		return nil, err
	}
	world, err := windows.CreateWellKnownSid(windows.WinWorldSid)
	if err != nil {
		return nil, err
	}

	lockErr := withPathLock(dir, func() error {
		sec, readErr := readSecurity(dir)
		if readErr != nil {
			return readErr
		}
		granted := hasACE(sec.dacl, accessAllowedACEType, subContainersAndObjectsInherit, grantMask, sid)
		deny := hasACE(sec.dacl, accessDeniedACEType, containerInheritACE, fileDeleteChild, world)
		labeled := hasACE(sec.sacl, systemMandatoryLabelACEType, subContainersAndObjectsInherit, systemMandatoryLabelNoWriteUp, low)
		if !granted && !deny && !labeled {
			sec.release()
			return nil
		}

		info := windows.SECURITY_INFORMATION(0)
		var daclArg *windows.ACL
		var keepAlive []byte
		if granted || deny {
			kept := keepACEs(sec.dacl, func(aceType, aceFlags byte, mask uint32, aceSID *windows.SID) bool {
				switch {
				case aceType == accessAllowedACEType && aceFlags == subContainersAndObjectsInherit &&
					mask == grantMask && aceSID != nil && windows.EqualSid(aceSID, sid):
					return false // 我们的能力 ACE
				case aceType == accessDeniedACEType && aceFlags == containerInheritACE &&
					mask == fileDeleteChild && aceSID != nil && windows.EqualSid(aceSID, world):
					return false // 我们的 ambient-delete deny
				default:
					return true
				}
			})
			if len(kept) == 0 {
				sec.release()
				return fmt.Errorf("撤销 %s 会留下空 DACL（等于全员拒绝），已放弃；请手工检查该目录的权限", dir)
			}
			buf, acl, buildErr := buildACL(kept)
			if buildErr != nil {
				sec.release()
				return buildErr
			}
			keepAlive = buf
			daclArg = acl
			info |= windows.SECURITY_INFORMATION(daclSecurityInformation)
		}
		if labeled {
			// 传 nil SACL + LABEL 位 = 清掉完整性标签
			info |= windows.SECURITY_INFORMATION(labelSecurityInformation)
		}
		_ = keepAlive
		sec.release()
		return windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, info, nil, nil, daclArg, nil)
	})
	if lockErr != nil {
		return nil, lockErr
	}
	return Scan(dir)
}

// keepACEs 复制保留的 ACE（原样字节），丢弃 drop 返回 false 的条目。
func keepACEs(acl *windows.ACL, drop func(aceType, aceFlags byte, mask uint32, sid *windows.SID) bool) [][]byte {
	if acl == nil {
		return nil
	}
	base := unsafe.Pointer(acl)
	aclSize := uintptr(*(*uint16)(unsafe.Add(base, 2)))
	count := int(*(*uint16)(unsafe.Add(base, 4)))
	if aclSize < 8 {
		return nil
	}
	kept := make([][]byte, 0, count)
	offset := uintptr(8)
	for i := 0; i < count; i++ {
		if offset+4 > aclSize {
			break
		}
		aceSize := uintptr(*(*uint16)(unsafe.Add(base, offset+2)))
		if aceSize < 8 || offset+aceSize > aclSize {
			break
		}
		aceType := *(*byte)(unsafe.Add(base, offset))
		aceFlags := *(*byte)(unsafe.Add(base, offset+1))
		mask := *(*uint32)(unsafe.Add(base, offset+4))
		sid := (*windows.SID)(unsafe.Add(base, offset+8))
		if drop(aceType, aceFlags, mask, sid) {
			ace := make([]byte, aceSize)
			copy(ace, unsafe.Slice((*byte)(unsafe.Add(base, offset)), int(aceSize)))
			kept = append(kept, ace)
		}
		offset += aceSize
	}
	return kept
}

// buildACL 用给定 ACE 字节重建一个 ACL（顺序保持原样）。
func buildACL(aces [][]byte) ([]byte, *windows.ACL, error) {
	total := 8
	for _, ace := range aces {
		total += len(ace)
	}
	buf := make([]byte, total)
	acl := (*windows.ACL)(unsafe.Pointer(&buf[0]))
	if r, _, callErr := procInitializeAcl.Call(uintptr(unsafe.Pointer(acl)), uintptr(total), aclRevision); r == 0 {
		return nil, nil, fmt.Errorf("InitializeAcl: %v", winErr(r, callErr))
	}
	for _, ace := range aces {
		if len(ace) == 0 {
			continue
		}
		// 0xFFFFFFFF = 追加到末尾（AddAce 的 dwStartingAceIndex 约定）
		if r, _, callErr := procAddAce.Call(uintptr(unsafe.Pointer(acl)), aclRevision, 0xFFFFFFFF,
			uintptr(unsafe.Pointer(&ace[0])), uintptr(len(ace))); r == 0 {
			return nil, nil, fmt.Errorf("AddAce: %v", winErr(r, callErr))
		}
	}
	return buf, acl, nil
}

// ---------- 授权失败诊断 ----------
//
// workspace-write 要在写根上写 DACL（能力 SID 的 allow ACE + Everyone 的 deny ACE）与
// 完整性标签，这需要该目录的 WRITE_DAC —— 目录所有者天然持有，别人得被显式授予。
// 工作区由另一个账户创建时（例如本地 admin 建的目录、当前登录的是 Microsoft 账户），
// 当前账户拿到的往往只是继承来的 Modify，而 Modify 不含「更改权限」，于是 grantWrite 报
// 裸的 Access is denied。这种情况下重试一万次也一样，只能把「缺什么、怎么补」翻出来。

// ownerSIDStringOf 取目录所有者 SID 字符串（S-1-5-21-…），用于与当前账户比对。
func ownerSIDStringOf(path string) (string, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	var owner *windows.SID
	var sd uintptr
	r, _, callErr := procGetNamedSecurityInfoW.Call(
		uintptr(unsafe.Pointer(name)), seFileObject, ownerSecurityInformation,
		uintptr(unsafe.Pointer(&owner)), 0, 0, 0,
		uintptr(unsafe.Pointer(&sd)),
	)
	if r != 0 {
		return "", fmt.Errorf("GetNamedSecurityInfoW(%s): %v", path, winErr(r, callErr))
	}
	defer windows.LocalFree(windows.Handle(sd))
	if owner == nil {
		return "", fmt.Errorf("目录没有所有者")
	}
	return owner.String(), nil
}

// currentUserSIDString 取当前进程令牌的用户 SID；拿不到返回空串（诊断退化为通用文案）。
func currentUserSIDString() string {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), tokenQuery, &token); err != nil {
		return ""
	}
	defer token.Close()
	var needed uint32
	_ = windows.GetTokenInformation(token, windows.TokenUser, nil, 0, &needed)
	if needed == 0 {
		return ""
	}
	buf := make([]byte, needed)
	if err := windows.GetTokenInformation(token, windows.TokenUser, &buf[0], needed, &needed); err != nil {
		return ""
	}
	info := (*windows.Tokenuser)(unsafe.Pointer(&buf[0]))
	if info.User.Sid == nil {
		return ""
	}
	return info.User.Sid.String()
}

// diagnoseGrantFailure 把「改不了这个目录的 ACL」翻成可操作的说明，附在 ErrUnavailable 后面。
func diagnoseGrantFailure(path string) string {
	owner, ownerErr := ownerSIDStringOf(path)
	me := currentUserSIDString()
	switch {
	case ownerErr != nil || owner == "" || me == "":
		return "（无法读取目录所有者，无法判断是否缺「更改权限」）"
	case owner == me:
		return "（当前账户就是该目录的所有者却仍被拒绝：检查安全软件拦截、目录只读属性或 ACL 保护）"
	}
	return "（该目录属于另一个账户，写 ACL 需要它的「更改权限」(WRITE_DAC)：" +
		"请以所有者身份运行本应用，或由管理员执行 icacls \"" + path + "\" /grant \"*" + me + ":(OI)(CI)WD\"）"
}

// ---------- Job ----------

func newKillOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, fmt.Errorf("CreateJobObject: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(job)
		return 0, fmt.Errorf("SetInformationJobObject: %w", err)
	}
	return job, nil
}

// ---------- 路径与 SID 派生 ----------

func canonicalDir(path, label string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("%s路径无效 %q: %w", label, path, err)
	}
	info, err := os.Stat(abs)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("%s不是已存在的目录：%s", label, abs)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", fmt.Errorf("%s无法规范化 %s: %w", label, abs, err)
	}
	return resolved, nil
}

// containsDir 判断 root 是否等于 candidate 或包含它（两边都已是物理路径）。
func containsDir(root, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

// workspaceWriteSIDString 由规范化路径派生稳定的 S-1-4-x-y：同一工作区跨会话
// 复用同一授权，standing ACE 只需传播一次。
func workspaceWriteSIDString(root string) string {
	sum := sha256.Sum256([]byte(root))
	return fmt.Sprintf("S-1-4-%d-%d", sidComponent(sum[0:4]), sidComponent(sum[4:8]))
}

// tempWriteSIDString 多一个子授权做域分离：temp 的授权与工作区永不互通。
func tempWriteSIDString(dir string) string {
	h := sha256.New()
	h.Write([]byte("temp\x00"))
	h.Write([]byte(dir))
	sum := h.Sum(nil)
	return fmt.Sprintf("S-1-4-%d-%d-1", sidComponent(sum[0:4]), sidComponent(sum[4:8]))
}

func sidComponent(b []byte) uint32 {
	return binary.LittleEndian.Uint32(b)%(1<<30-1) + 1
}

func parseSID(sddl string) (*windows.SID, error) {
	ptr, err := windows.UTF16PtrFromString(sddl)
	if err != nil {
		return nil, err
	}
	var sid *windows.SID
	if err := windows.ConvertStringSidToSid(ptr, &sid); err != nil {
		return nil, fmt.Errorf("ConvertStringSidToSid(%s): %w", sddl, err)
	}
	return sid, nil
}

// winErr 把 LazyProc 的 r1（Win32 错误码）转成 error。
func winErr(code uintptr, fallback error) error {
	if code == 0 {
		return fallback
	}
	return windows.Errno(code)
}
