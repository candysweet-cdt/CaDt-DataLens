package dbclient

// session.go：连接注册表与生命周期——会话上限、空闲回收、查询取消登记。
// 会话是一个连接的持有者；元数据 L2 结果按 (db, table) 缓存在会话内，写后由前端显式刷新
// （方案 §3.1 的 smart refresh 由 DBDescribe 传 noCache 实现）。

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"
)

// dbSession 单个连接的会话；SQL 会话持有 *sql.DB（SQLite 限 1 连接、MySQL 限 1–2），
// Redis 会话持有 redisClient（redis != nil，db == nil）——两族共用登记/回收/取消机制。
type dbSession struct {
	id        string
	kind      string
	name      string
	server    string
	database  string
	editable  bool
	immutable bool
	caps      Capabilities
	db        *sql.DB
	redis     *redisClient

	mu       sync.Mutex
	meta     map[string]*DBTableMeta
	active   map[string]context.CancelFunc
	lastUsed time.Time
}

var (
	sessionsMu sync.Mutex
	sessions   = map[string]*dbSession{}
	sessionSeq int64
	sweeperMu  sync.Mutex
	sweeperOn  bool
)

func nextSessionID() string { return nextOperationID("db") }

func nextOperationID(prefix string) string {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	sessionSeq++
	return fmt.Sprintf("%s-%d-%d", prefix, time.Now().UnixNano(), sessionSeq)
}

// openSession 走驱动建连并登记；超限时先回收空闲会话，仍满则拒绝。
// Redis 不进 Driver 注册表（driver.go 的既定声明），在分派最前面单独建连，
// 但生命周期登记（上限/空闲回收/取消）与 SQL 会话共用同一条流程。
func openSession(spec openSpec) (SessionInfo, error) {
	if spec.Kind == kindRedis {
		return openRedisSession(spec)
	}
	drv, err := driverFor(spec.Kind)
	if err != nil {
		return SessionInfo{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	s, err := drv.Open(ctx, spec)
	if err != nil {
		return SessionInfo{}, err
	}
	return registerSession(s)
}

// registerSession 会话登记通用流程：填 id/缓存/取消表 → 上限回收 → 进注册表。
// （SQL 会话由 openSession 在驱动 Open 后调用；Redis 会话由 openRedisSession 建连后调用。）
func registerSession(s *dbSession) (SessionInfo, error) {
	s.id = nextSessionID()
	s.meta = map[string]*DBTableMeta{}
	s.active = map[string]context.CancelFunc{}
	s.lastUsed = time.Now()

	var evicted *dbSession
	sessionsMu.Lock()
	if len(sessions) >= maxSessions {
		evicted = evictIdleLocked()
	}
	if len(sessions) >= maxSessions {
		sessionsMu.Unlock()
		closeSessionConn(s)
		return SessionInfo{}, fmt.Errorf("连接数已达上限（%d），请先断开不用的连接", maxSessions)
	}
	sessions[s.id] = s
	sessionsMu.Unlock()
	// Close 可能阻塞（MySQL COM_QUIT 受 WriteTimeout 约束）：拿到锁外执行，不拖累其他会话操作
	if evicted != nil {
		closeSessionConn(evicted)
		logWarn("连接数超限，回收空闲会话：%s（%s）", evicted.name, evicted.id)
	}
	startSweeper()
	return s.info(), nil
}

// evictIdleLocked 挑出最久未用的空闲会话并从注册表摘除（调用方持有 sessionsMu）。
// Close 由调用方在锁外执行——db.Close 可能做阻塞 I/O。
func evictIdleLocked() *dbSession {
	var oldest *dbSession
	var oldestUsed time.Time
	for _, s := range sessions {
		s.mu.Lock()
		idle := time.Since(s.lastUsed) > idleCloseAfter && len(s.active) == 0
		used := s.lastUsed
		s.mu.Unlock()
		if !idle {
			continue
		}
		if oldest == nil || used.Before(oldestUsed) {
			oldest = s
			oldestUsed = used
		}
	}
	if oldest != nil {
		delete(sessions, oldest.id)
	}
	return oldest
}

func getSession(id string) (*dbSession, error) {
	// touch 在持 sessionsMu 期间做：sweeper 的空闲判定拿同一把锁，消除「刚用完即被回收」的窗口
	sessionsMu.Lock()
	s := sessions[id]
	if s != nil {
		s.mu.Lock()
		s.lastUsed = time.Now()
		s.mu.Unlock()
	}
	sessionsMu.Unlock()
	if s == nil {
		return nil, ErrSessionNotFound
	}
	return s, nil
}

// CloseSession 显式断开。
func CloseSession(id string) error {
	sessionsMu.Lock()
	s := sessions[id]
	delete(sessions, id)
	sessionsMu.Unlock()
	if s == nil {
		return ErrSessionNotFound
	}
	closeSessionConn(s)
	return nil
}

// startSweeper 空闲回收扫描（进程生命周期内一个 goroutine，幂等启动）。
func startSweeper() {
	sweeperMu.Lock()
	defer sweeperMu.Unlock()
	if sweeperOn {
		return
	}
	sweeperOn = true
	go func() {
		ticker := time.NewTicker(idleSweepEvery)
		defer ticker.Stop()
		for range ticker.C {
			sweepIdleSessions()
		}
	}()
}

func sweepIdleSessions() {
	sessionsMu.Lock()
	victims := make([]*dbSession, 0, 1)
	for id, s := range sessions {
		s.mu.Lock()
		idle := time.Since(s.lastUsed) > idleCloseAfter && len(s.active) == 0
		s.mu.Unlock()
		if idle {
			victims = append(victims, s)
			delete(sessions, id)
		}
	}
	sessionsMu.Unlock()
	for _, s := range victims {
		closeSessionConn(s)
		logWarn("空闲超时断开连接：%s（%s）", s.name, s.id)
	}
}

func (s *dbSession) info() SessionInfo {
	return SessionInfo{
		ID:        s.id,
		Kind:      s.kind,
		Name:      s.name,
		Server:    s.server,
		Database:  s.database,
		Editable:  s.editable && s.caps.Editable,
		Immutable: s.immutable,
	}
}

// ---------- 查询取消登记 ----------

func (s *dbSession) registerQuery(queryID string, cancel context.CancelFunc) {
	s.mu.Lock()
	s.active[queryID] = cancel
	s.mu.Unlock()
}

func (s *dbSession) unregisterQuery(queryID string) {
	s.mu.Lock()
	delete(s.active, queryID)
	s.mu.Unlock()
}

// Cancel 取消执行中的查询（context 取消驱动 driver 侧中断；慢查询不再只能等超时）。
func Cancel(id, queryID string) error {
	s, err := getSession(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	cancel := s.active[queryID]
	s.mu.Unlock()
	if cancel == nil {
		return fmt.Errorf("查询不在执行中：%s", queryID)
	}
	cancel()
	return nil
}

// ---------- 元数据（按方言分派 + 会话内缓存） ----------

// describeMeta 拉取表元数据（L2）；缓存键带库名，noCache 供写后刷新。
func describeMeta(s *dbSession, database, table string, noCache bool) (*DBTableMeta, error) {
	key := database + "\x00" + table
	s.mu.Lock()
	cached := s.meta[key]
	s.mu.Unlock()
	if cached != nil && !noCache {
		return cached, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	var meta *DBTableMeta
	var err error
	switch s.kind {
	case kindSQLite:
		meta, err = sqliteDescribe(ctx, s, database, table)
	case kindMySQL:
		meta, err = mysqlDescribe(ctx, s, database, table)
	case kindRedis:
		return nil, fmt.Errorf("Redis 没有表元数据；键值查看走键空间专用路径")
	default:
		err = fmt.Errorf("未知方言：%s", s.kind)
	}
	if err != nil {
		return nil, err
	}
	meta.Editable = s.editable && s.caps.Editable && len(meta.PK) > 0 && meta.Kind != "view"
	s.mu.Lock()
	s.meta[key] = meta
	s.mu.Unlock()
	return meta, nil
}

// listObjectsMeta 元数据 L1：库/表清单（Redis 无表概念——键空间走 RedisScanKeys 专用路径）。
func listObjectsMeta(s *dbSession, database string) ([]DBObject, error) {
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	switch s.kind {
	case kindSQLite:
		return sqliteListObjects(ctx, s, database)
	case kindMySQL:
		return mysqlListObjects(ctx, s, database)
	case kindRedis:
		return nil, fmt.Errorf("Redis 没有表概念；键空间在侧栏直接浏览")
	default:
		return nil, fmt.Errorf("未知方言：%s", s.kind)
	}
}

// listDatabasesMeta 库清单（SQLite 返回 main 占位、Redis 返回连接绑定的库，
// 让对象树/键空间树两族共用一套交互）。
func listDatabasesMeta(s *dbSession) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), queryTimeout)
	defer cancel()
	switch s.kind {
	case kindSQLite:
		return []string{"main"}, nil
	case kindMySQL:
		return mysqlListDatabases(ctx, s)
	case kindRedis:
		return []string{s.database}, nil
	default:
		return nil, fmt.Errorf("未知方言：%s", s.kind)
	}
}
