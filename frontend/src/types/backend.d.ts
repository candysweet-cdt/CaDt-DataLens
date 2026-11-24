// backend.d.ts：Wails 绑定面类型——**自动生成，不要手改**。
//
// 生成：node scripts/gen-backend-types.mjs（名单来自 testdata/app_bindings_baseline.txt，420 个方法）
// 名单由 app_bindings_guard_test.go 校验，前端 FQN 是 main.App.<Method>；
// 运行时经 Call.ByName 动态解析（frontend/src/core/wails-runtime.js 的 createBackendProxy）。
//
// 本次签名覆盖：精确 263 / 含 unknown 157 / 签名冲突 0 / 未找到 0
// 含 unknown 的行上方有 @go 注释，写明 Go 原始签名与待补的结构体名。
//
// 用法（阶梯 1 之后，jsconfig 仍保持 checkJs:false）：
//   /** @type {import('../types/backend').Backend} */
//   const backend = createBackendProxy(Call);

export interface GitOperationResult {
    success: boolean;
    output: string;
    branch?: string;
    path?: string;
    conflictFiles?: string[];
}
export interface PluginInfo {
    id: string;
    name: string;
    version?: string;
    author: string;
    description?: string;
    dir: string;
    entry?: string;
    extensions?: string[];
    homepage?: string;
    repository?: string;
    license?: string;
    keywords?: string[];
    minAppVersion?: string;
    iconData?: string;
    enabled: boolean;
    entryOk: boolean;
}
export interface AISchedule {
    id: string;
    name: string;
    kind: string;
    at?: string;
    intervalMinutes?: number;
    cron?: string;
    prompt: string;
    sessionId: string;
    scope: string;
    enabled: boolean;
    createdAt: number;
    lastRunAt: number;
    nextRunAt: number;
    runCount: number;
    maxRuns: number;
    lastResult: string;
}
export interface Backend {
    AIAppDir(): Promise<string>;
    AIArtifactClear(sessionID: string): Promise<void>;
    AIArtifactClearAll(): Promise<void>;
    AIArtifactRead(sessionID: string, name: string): Promise<string>;
    AIArtifactWrite(sessionID: string, name: string, content: string): Promise<string>;
    AIBuiltinSkillsDir(): Promise<string>;
    /** @go AICommandStart(command string, cwd string, shell string) → (*AICommandJobStart, error) // 待补: AICommandJobStart */
    AICommandStart(command: string, cwd: string, shell: string): Promise<unknown>;
    /** @go AICommandStartConfined(command string, cwd string, mode string, workspaceRoot string, shell string) → (*AICommandJobStart, error) // 待补: AICommandJobStart */
    AICommandStartConfined(command: string, cwd: string, mode: string, workspaceRoot: string, shell: string): Promise<unknown>;
    /** @go AICommandStatus(jobId string, since int64) → (*AICommandJobStatus, error) // 待补: AICommandJobStatus */
    AICommandStatus(jobId: string, since: number): Promise<unknown>;
    /** @go AICommandStop(jobId string) → (*AICommandJobStatus, error) // 待补: AICommandJobStatus */
    AICommandStop(jobId: string): Promise<unknown>;
    AIConfigBackupSealed(): Promise<string>;
    AIConfigRead(): Promise<string>;
    AIConfigWrite(data: string): Promise<void>;
    AIEnsureDir(dir: string): Promise<void>;
    AIExePath(): Promise<string>;
    /** @go AIGenHTTPRequest(specJSON string) → (HTTPResult) // 待补: HTTPResult */
    AIGenHTTPRequest(specJSON: string): Promise<unknown>;
    /** @go AIGenSaveProducts(specJSON string) → (SaveResult) // 待补: SaveResult */
    AIGenSaveProducts(specJSON: string): Promise<unknown>;
    AIGroupAppend(id: string, lines: string): Promise<void>;
    AIGroupDelete(id: string): Promise<void>;
    AIGroupDeleteAll(): Promise<void>;
    AIGroupList(): Promise<string[]>;
    AIGroupPrivateAppend(groupID: string, agentID: string, lines: string): Promise<void>;
    AIGroupPrivateRead(groupID: string, agentID: string): Promise<string>;
    AIGroupPrivateRewrite(groupID: string, agentID: string, content: string): Promise<void>;
    AIGroupRead(id: string): Promise<string>;
    AIGroupRewrite(id: string, content: string): Promise<void>;
    AIGroupWriteMeta(id: string, data: string): Promise<void>;
    AIHomeDir(): Promise<string>;
    /** @go AIImageLimits() → (ImageLimits) // 待补: ImageLimits */
    AIImageLimits(): Promise<unknown>;
    /** @go AIListModels(cfg aitransport.Config) → ([]string, error) // 待补: Config */
    AIListModels(cfg: unknown): Promise<string[]>;
    /** @go AIModelCatalogCached() → (*Blob, error) // 待补: Blob */
    AIModelCatalogCached(): Promise<unknown>;
    /** @go AIModelCatalogSync(rawURL string) → (*Blob, error) // 待补: Blob */
    AIModelCatalogSync(rawURL: string): Promise<unknown>;
    /** @go AIOAuthQuotaFetch(providerID string, rawURL string) → (oauthquota.FetchResult) // 待补: FetchResult */
    AIOAuthQuotaFetch(providerID: string, rawURL: string): Promise<unknown>;
    /** @go AIOAuthQuotaLogin(providerID string, username string, password string) → (oauthquota.LoginResult) // 待补: LoginResult */
    AIOAuthQuotaLogin(providerID: string, username: string, password: string): Promise<unknown>;
    AIOAuthQuotaLogout(providerID: string): Promise<string>;
    /** @go AIOAuthQuotaProviders() → ([]struct) // 待补: struct */
    AIOAuthQuotaProviders(): Promise<unknown[]>;
    /** @go AIOAuthQuotaStatus(providerID string) → (oauthquota.StatusResult) // 待补: StatusResult */
    AIOAuthQuotaStatus(providerID: string): Promise<unknown>;
    /** @go AIRunShellCommand(command string, cwd string, timeoutMs int, runId string, shell string) → (*AIShellCommandResult, error) // 待补: AIShellCommandResult */
    AIRunShellCommand(command: string, cwd: string, timeoutMs: number, runId: string, shell: string): Promise<unknown>;
    /** @go AIRunShellCommandConfined(command string, cwd string, timeoutMs int, runId string, mode string, workspaceRoot string, shell string) → (*AIShellCommandResult, error) // 待补: AIShellCommandResult */
    AIRunShellCommandConfined(command: string, cwd: string, timeoutMs: number, runId: string, mode: string, workspaceRoot: string, shell: string): Promise<unknown>;
    /** @go AIScheduleCreate(input AIScheduleInput) → (*AISchedule, error) // 待补: AIScheduleInput */
    AIScheduleCreate(input: unknown): Promise<AISchedule | null>;
    AIScheduleDelete(id: string): Promise<void>;
    AIScheduleList(): Promise<(AISchedule | null)[]>;
    AIScheduleSetResult(id: string, ok: boolean, note: string): Promise<void>;
    AIScheduleToggle(id: string, enabled: boolean): Promise<AISchedule | null>;
    /** @go AIScheduleUpdate(id string, input AIScheduleInput) → (*AISchedule, error) // 待补: AIScheduleInput */
    AIScheduleUpdate(id: string, input: unknown): Promise<AISchedule | null>;
    /** @go AISendChat(sessionId string, cfg aitransport.Config, messages []aitransport.Message, tools []aitransport.ToolDef, retryMax int) → (error) // 待补: Config, Message, ToolDef */
    AISendChat(sessionId: string, cfg: unknown, messages: unknown[], tools: unknown[], retryMax: number): Promise<void>;
    AISessionAppend(id: string, lines: string, allowCreate: boolean): Promise<void>;
    AISessionArchiveClear(id: string): Promise<void>;
    AISessionDelete(id: string): Promise<void>;
    AISessionDeleteAll(): Promise<void>;
    AISessionIndexPath(): Promise<string>;
    /** @go AISessionIndexStats() → (IndexStats, error) // 待补: IndexStats */
    AISessionIndexStats(): Promise<unknown>;
    /** @go AISessionLeaseAcquire(ctx context.Context, id string, purpose string, label string, timeoutMs int) → (LeaseStatus, error) // 待补: LeaseStatus */
    AISessionLeaseAcquire(id: string, purpose: string, label: string, timeoutMs: number): Promise<unknown>;
    AISessionLeaseRelease(id: string): Promise<void>;
    AISessionLeaseReleaseByOwner(owner: string): Promise<number>;
    /** @go AISessionLeaseStatus(id string) → (LeaseStatus, error) // 待补: LeaseStatus */
    AISessionLeaseStatus(id: string): Promise<unknown>;
    AISessionList(): Promise<string[]>;
    AISessionPath(id: string): Promise<string>;
    AISessionRead(id: string): Promise<string>;
    /** @go AISessionReadArchive(id string, offset int, limit int) → (ArchivePage, error) // 待补: ArchivePage */
    AISessionReadArchive(id: string, offset: number, limit: number): Promise<unknown>;
    AISessionReadForce(id: string): Promise<string>;
    AISessionReadImage(id: string, name: string): Promise<string>;
    AISessionReadVideo(id: string, name: string): Promise<string>;
    AISessionReindex(): Promise<number>;
    AISessionRewrite(id: string, content: string): Promise<void>;
    AISessionSaveImage(id: string, name: string, dataURL: string, workspace: string): Promise<string>;
    AISessionSaveVideo(id: string, name: string, dataURL: string, workspace: string): Promise<string>;
    /** @go AISessionSearch(query string, limit int) → ([]SearchHit, error) // 待补: SearchHit */
    AISessionSearch(query: string, limit: number): Promise<unknown[]>;
    /** @go AISessionSearchScoped(query string, limit int, brief bool) → (ScopedSearchResult, error) // 待补: ScopedSearchResult */
    AISessionSearchScoped(query: string, limit: number, brief: boolean): Promise<unknown>;
    /** @go AISessionStat(id string) → (LogStat, error) // 待补: LogStat */
    AISessionStat(id: string): Promise<unknown>;
    AISessionStoreRoot(): Promise<string>;
    AISessionUnwatch(id: string): Promise<void>;
    /** @go AISessionVacuum(ctx context.Context, id string, force bool) → (VacuumResult, error) // 待补: VacuumResult */
    AISessionVacuum(id: string, force: boolean): Promise<unknown>;
    AISessionWatch(id: string): Promise<void>;
    AISessionWriteMeta(id: string, data: string): Promise<void>;
    AIStop(sessionId: string): Promise<void>;
    AIStopShellRun(id: string): Promise<void>;
    /** @go AITestConnection(cfg aitransport.Config) → (string, error) // 待补: Config */
    AITestConnection(cfg: unknown): Promise<string>;
    AITouchStream(sessionId: string): Promise<void>;
    /** @go AIUsageHTTPRequest(specJSON string) → (aigen.HTTPResult) // 待补: HTTPResult */
    AIUsageHTTPRequest(specJSON: string): Promise<unknown>;
    /** @go AIUsageQuery(cfg aitransport.Config) → (AIUsageResult) // 待补: Config, AIUsageResult */
    AIUsageQuery(cfg: unknown): Promise<unknown>;
    AIUsageStatsRecord(payloadJSON: string): Promise<string>;
    /** @go AIUsageStatsRequests(offset int, limit int) → (RequestPage) // 待补: RequestPage */
    AIUsageStatsRequests(offset: number, limit: number): Promise<unknown>;
    /** @go AIUsageStatsSnapshot(rangeKey string) → (Snapshot) // 待补: Snapshot */
    AIUsageStatsSnapshot(rangeKey: string): Promise<unknown>;
    AIUsageStatsSync(): Promise<string>;
    AIWorklogAppend(root: string, title: string, summary: string): Promise<string>;
    ActivityAppend(entriesJSON: string): Promise<void>;
    ActivityClear(): Promise<void>;
    ActivityPath(): Promise<string>;
    ActivityRead(queryJSON: string): Promise<string>;
    /** @go AddPluginFromFolder(ctx context.Context) → (*plugins.PluginInfo, error) // 待补: PluginInfo */
    AddPluginFromFolder(): Promise<unknown>;
    AppGracefulQuitAck(): Promise<void>;
    /** @go AppServiceList() → ([]appservices.Status) // 待补: Status */
    AppServiceList(): Promise<unknown[]>;
    AppServiceLogs(id: string): Promise<string[]>;
    AppServiceStart(id: string): Promise<void>;
    /** @go AppServiceStatus(id string) → (appservices.Status, error) // 待补: Status */
    AppServiceStatus(id: string): Promise<unknown>;
    AppServiceStop(id: string): Promise<void>;
    /** @go AppServiceSync(specs []appservices.Spec) → (error) // 待补: Spec */
    AppServiceSync(specs: unknown[]): Promise<void>;
    AppWindowActive(): Promise<boolean>;
    BrowserCallCDP(id: string, method: string, paramsJSON: string): Promise<string>;
    BrowserCaptureScreenshot(id: string): Promise<string>;
    BrowserClose(id: string): Promise<void>;
    BrowserCloseByOwner(hwnd: number): Promise<number>;
    BrowserEnsureZ(id: string): Promise<void>;
    BrowserEval(id: string, script: string): Promise<string>;
    BrowserFocus(id: string): Promise<void>;
    BrowserGoBack(id: string): Promise<void>;
    BrowserGoForward(id: string): Promise<void>;
    BrowserNavigate(id: string, url: string): Promise<void>;
    BrowserOpen(id: string, url: string, profileKey: string): Promise<Record<string, string>>;
    BrowserReload(id: string): Promise<void>;
    BrowserSetBounds(id: string, x: number, y: number, w: number, h: number, viewportWidth: number, viewportHeight: number): Promise<void>;
    BrowserSetVisible(id: string, visible: boolean): Promise<void>;
    BrowserSnapshot(id: string): Promise<string>;
    /** @go BrowserState(id string) → (map[string]interface{}, error) */
    BrowserState(id: string): Promise<Record<string, unknown>>;
    BrowserStop(id: string): Promise<void>;
    CancelReadingSearch(requestID: string): Promise<void>;
    CaptureAppScreenshot(): Promise<string>;
    CaptureAppScreenshotRegion(x: number, y: number, width: number, height: number): Promise<string>;
    CheckEncoding(content: string, enc: string): Promise<boolean>;
    /** @go CheckForUpdates() → (*UpdateInfo, error) // 待补: UpdateInfo */
    CheckForUpdates(): Promise<unknown>;
    CleanupRunTemp(dir: string): Promise<void>;
    CleanupRunTempStale(): Promise<number>;
    CognitionEdit(workspace: string, reqJSON: string): Promise<string>;
    CognitionRead(workspace: string, reqJSON: string): Promise<string>;
    CognitionStatus(workspace: string, verbose: boolean): Promise<string>;
    ConsumeStartupSettings(): Promise<string>;
    CopyEntry(src: string, destDir: string, newName: string): Promise<string>;
    CopyFileTo(srcPath: string, destPath: string): Promise<void>;
    CopyText(text: string): Promise<void>;
    CreateEntry(dir: string, name: string, isDir: boolean): Promise<string>;
    /** @go DBApplyChanges(id string, changes TableChanges) → (ApplyResult, error) // 待补: TableChanges, ApplyResult */
    DBApplyChanges(id: string, changes: unknown): Promise<unknown>;
    /** @go DBBrowse(id string, req BrowseRequest) → (sqlview.SQLResult, error) // 待补: BrowseRequest, SQLResult */
    DBBrowse(id: string, req: unknown): Promise<unknown>;
    DBCancel(id: string, queryID: string): Promise<void>;
    DBClose(id: string): Promise<void>;
    /** @go DBConnect(connectionID string) → (SessionInfo, error) // 待补: SessionInfo */
    DBConnect(connectionID: string): Promise<unknown>;
    DBCreateSQLite(path: string): Promise<void>;
    DBCredentialGet(key: string): Promise<string>;
    DBCredentialPut(key: string, plain: string): Promise<void>;
    DBDeleteConnection(id: string): Promise<void>;
    /** @go DBDescribe(id string, database string, table string, noCache bool) → (*DBTableMeta, error) // 待补: DBTableMeta */
    DBDescribe(id: string, database: string, table: string, noCache: boolean): Promise<unknown>;
    /** @go DBListConnections() → ([]ConnectionConfig, error) // 待补: ConnectionConfig */
    DBListConnections(): Promise<unknown[]>;
    DBListDatabases(id: string): Promise<string[]>;
    /** @go DBListObjects(id string, database string) → ([]DBObject, error) // 待补: DBObject */
    DBListObjects(id: string, database: string): Promise<unknown[]>;
    /** @go DBListServerObjects(id string) → (*ServerObjects, error) // 待补: ServerObjects */
    DBListServerObjects(id: string): Promise<unknown>;
    /** @go DBOpen(path string, allowEdit bool) → (SessionInfo, error) // 待补: SessionInfo */
    DBOpen(path: string, allowEdit: boolean): Promise<unknown>;
    /** @go DBPreviewChanges(id string, changes TableChanges) → ([]ChangeStatement, error) // 待补: TableChanges, ChangeStatement */
    DBPreviewChanges(id: string, changes: unknown): Promise<unknown[]>;
    /** @go DBQuery(id string, queryID string, query string, confirmed bool, limit int) → (QueryOutcome, error) // 待补: QueryOutcome */
    DBQuery(id: string, queryID: string, query: string, confirmed: boolean, limit: number): Promise<unknown>;
    DBReadImportFile(path: string): Promise<string>;
    /** @go DBRedisApply(id string, ops []RedisOp) → (sqlview.SQLResult, error) // 待补: RedisOp, SQLResult */
    DBRedisApply(id: string, ops: unknown[]): Promise<unknown>;
    /** @go DBRedisDeleteByPrefix(id string, database string, prefix string) → (RedisPrefixDelete, error) // 待补: RedisPrefixDelete */
    DBRedisDeleteByPrefix(id: string, database: string, prefix: string): Promise<unknown>;
    /** @go DBRedisFetchValue(id string, database string, key string) → (RedisValue, error) // 待补: RedisValue */
    DBRedisFetchValue(id: string, database: string, key: string): Promise<unknown>;
    /** @go DBRedisScan(id string, database string, pattern string, cursor uint64, count int, typeFilter string) → (RedisScanResult, error) // 待补: RedisScanResult */
    DBRedisScan(id: string, database: string, pattern: string, cursor: number, count: number, typeFilter: string): Promise<unknown>;
    /** @go DBSaveConnection(cfg ConnectionConfig, password string) → (ConnectionConfig, error) // 待补: ConnectionConfig */
    DBSaveConnection(cfg: unknown, password: string): Promise<unknown>;
    /** @go DBTestConnection(cfg ConnectionConfig, password string) → (string, error) // 待补: ConnectionConfig */
    DBTestConnection(cfg: unknown, password: string): Promise<string>;
    /** @go DebugConsoleAppend(entries []DebugConsoleEntry) → (error) // 待补: DebugConsoleEntry */
    DebugConsoleAppend(entries: unknown[]): Promise<void>;
    /** @go DebugConsoleRead(offset int64) → (DebugConsoleChunk, error) // 待补: DebugConsoleChunk */
    DebugConsoleRead(offset: number): Promise<unknown>;
    DeleteEntry(path: string): Promise<void>;
    DeletePlugin(id: string): Promise<void>;
    /** @go DetectRunProject(path string) → (*RunProjectInfo, error) // 待补: RunProjectInfo */
    DetectRunProject(path: string): Promise<unknown>;
    /** @go DetectToolchain(kind string, override string) → (*ToolchainScan, error) // 待补: ToolchainScan */
    DetectToolchain(kind: string, override: string): Promise<unknown>;
    DirMtime(path: string): Promise<number>;
    ExportDebugConsoleLog(defaultName: string, content: string): Promise<string>;
    ExportStructureDir(dir: string): Promise<string>;
    ExportStructureText(defaultName: string, content: string): Promise<string>;
    /** @go ExternalASR(name string, path string, wavBase64 string) → (map[string]interface{}, error) */
    ExternalASR(name: string, path: string, wavBase64: string): Promise<Record<string, unknown>>;
    /** @go ExternalFetch(rawURL string, maxChars int) → (map[string]interface{}, error) */
    ExternalFetch(rawURL: string, maxChars: number): Promise<Record<string, unknown>>;
    /** @go ExternalOCR(path string, purpose string) → (map[string]interface{}, error) */
    ExternalOCR(path: string, purpose: string): Promise<Record<string, unknown>>;
    /** @go ExternalSearch(query string, maxResults int) → (map[string]interface{}, error) */
    ExternalSearch(query: string, maxResults: number): Promise<Record<string, unknown>>;
    /** @go ExternalTTS(workspace string, text string, voice string) → (map[string]interface{}, error) */
    ExternalTTS(workspace: string, text: string, voice: string): Promise<Record<string, unknown>>;
    /** @go FindFiles(root string, pattern string, maxResults int) → (*FindFilesResult, error) // 待补: FindFilesResult */
    FindFiles(root: string, pattern: string, maxResults: number): Promise<unknown>;
    FinishConvert(payload: string): Promise<void>;
    ForceClose(): Promise<void>;
    ForceQuitAll(): Promise<void>;
    /** @go GetAgentSkillStatus() → (*AgentSkillStatus, error) // 待补: AgentSkillStatus */
    GetAgentSkillStatus(): Promise<unknown>;
    GetAppVersion(): Promise<string>;
    GetAuxWindowKind(): Promise<string>;
    GetClipboardImage(): Promise<string>;
    GetClipboardText(): Promise<string>;
    GetCloseAction(): Promise<string>;
    GetConvertRequest(): Promise<string>;
    GetDataSource(): Promise<string>;
    GetDeveloperMode(): Promise<boolean>;
    /** @go GetEnvVars() → (*EnvVarSnapshot, error) // 待补: EnvVarSnapshot */
    GetEnvVars(): Promise<unknown>;
    /** @go GetFileStat(path string) → (*FileStatInfo, error) // 待补: FileStatInfo */
    GetFileStat(path: string): Promise<unknown>;
    /** @go GetIntegrationStatus() → (*IntegrationStatus, error) // 待补: IntegrationStatus */
    GetIntegrationStatus(): Promise<unknown>;
    GetLogPath(): Promise<string>;
    GetOpenMode(): Promise<string>;
    /** @go GetPathInfo(path string) → (*PathInfo, error) // 待补: PathInfo */
    GetPathInfo(path: string): Promise<unknown>;
    /** @go GetPluginMarket() → ([]*MarketPlugin, error) // 待补: MarketPlugin */
    GetPluginMarket(): Promise<unknown[]>;
    /** @go GetPluginSources() → ([]PluginSource, error) // 待补: PluginSource */
    GetPluginSources(): Promise<unknown[]>;
    GetPlugins(): Promise<(PluginInfo | null)[]>;
    GetPluginsDir(): Promise<string>;
    GetPluginsPathMode(): Promise<string>;
    GetRunTempDir(): Promise<string>;
    GetStartupAISession(): Promise<string>;
    GetStartupDiff(): Promise<Record<string, string>>;
    GetStartupFiles(): Promise<string[]>;
    GetStartupLight(): Promise<Record<string, string>>;
    GetStartupMemo(): Promise<Record<string, string>>;
    GetStartupMemoLocator(): Promise<string>;
    GetStartupMonitorSession(): Promise<Record<string, string>>;
    GetStartupPreview(): Promise<Record<string, string>>;
    /** @go GetStartupTargets(ctx context.Context) → ([]launchargs.OpenTarget) // 待补: OpenTarget */
    GetStartupTargets(): Promise<unknown[]>;
    GetStartupTermID(): Promise<string>;
    GetSystemCursors(): Promise<Record<string, string>>;
    /** @go GitBranchesFor(dir string, includeRemote bool) → (*GitBranchesResult, error) // 待补: GitBranchesResult */
    GitBranchesFor(dir: string, includeRemote: boolean): Promise<unknown>;
    GitCheckoutBranch(dir: string, name: string, remote: boolean): Promise<GitOperationResult | null>;
    GitCheckoutRefFor(dir: string, ref: string): Promise<GitOperationResult | null>;
    GitCloneRepository(url: string, target: string): Promise<GitOperationResult | null>;
    /** @go GitCommitChanges(dir string, message string, paths []string, amend bool, push bool) → (*GitCommitResult, error) // 待补: GitCommitResult */
    GitCommitChanges(dir: string, message: string, paths: string[], amend: boolean, push: boolean): Promise<unknown>;
    GitCreateBranch(dir: string, name: string): Promise<GitOperationResult | null>;
    /** @go GitDiffFor(dir string, path string) → (*GitDiffResult, error) // 待补: GitDiffResult */
    GitDiffFor(dir: string, path: string): Promise<unknown>;
    GitFetchFor(dir: string): Promise<GitOperationResult | null>;
    GitFileHistoryFor(dir: string, path: string, limit: number): Promise<string>;
    GitGraphCheckout(dir: string, ref: string): Promise<GitOperationResult | null>;
    GitGraphCheckoutForce(dir: string, ref: string): Promise<GitOperationResult | null>;
    GitGraphCheckoutSmart(dir: string, ref: string): Promise<GitOperationResult | null>;
    GitGraphCherryPick(dir: string, sha: string): Promise<GitOperationResult | null>;
    GitGraphCommitBody(dir: string, sha: string): Promise<string>;
    /** @go GitGraphCommitFileDiff(dir string, sha string, path string, maxLines int) → (*GitDiffResult, error) // 待补: GitDiffResult */
    GitGraphCommitFileDiff(dir: string, sha: string, path: string, maxLines: number): Promise<unknown>;
    /** @go GitGraphCommitFiles(dir string, sha string) → ([]GitGraphFileChange, error) // 待补: GitGraphFileChange */
    GitGraphCommitFiles(dir: string, sha: string): Promise<unknown[]>;
    /** @go GitGraphCommits(dir string, ref string, limit int, skip int) → (*GitGraphPage, error) // 待补: GitGraphPage */
    GitGraphCommits(dir: string, ref: string, limit: number, skip: number): Promise<unknown>;
    GitGraphCreateBranch(dir: string, name: string, sha: string, checkout: boolean): Promise<GitOperationResult | null>;
    /** @go GitGraphRefs(dir string) → (*GitGraphRefsResult, error) // 待补: GitGraphRefsResult */
    GitGraphRefs(dir: string): Promise<unknown>;
    GitGraphReset(dir: string, sha: string, mode: string): Promise<GitOperationResult | null>;
    /** @go GitLineMarksFor(dir string, path string, content string) → (*GitLineMarks, error) // 待补: GitLineMarks */
    GitLineMarksFor(dir: string, path: string, content: string): Promise<unknown>;
    GitPatchID(diffText: string): Promise<string>;
    GitPullFor(dir: string): Promise<GitOperationResult | null>;
    GitPushFor(dir: string): Promise<GitOperationResult | null>;
    GitRecentLogFor(dir: string, limit: number): Promise<string>;
    GitRollbackFor(dir: string, paths: string[], untracked: string[]): Promise<void>;
    /** @go GitStatusFor(dir string) → (*GitTreeStatus, error) // 待补: GitTreeStatus */
    GitStatusFor(dir: string): Promise<unknown>;
    /** @go GitWorktreeAdd(dir string, label string, sessionKey string, carry bool) → (*GitWorktreeAddResult, error) // 待补: GitWorktreeAddResult */
    GitWorktreeAdd(dir: string, label: string, sessionKey: string, carry: boolean): Promise<unknown>;
    GitWorktreeDiff(dir: string, name: string, baseSha: string): Promise<string>;
    GitWorktreeDiffSinceBase(dir: string, baseSha: string, path: string, maxLines: number): Promise<string>;
    /** @go GitWorktreeList(dir string) → (*GitWorktreeListResult, error) // 待补: GitWorktreeListResult */
    GitWorktreeList(dir: string): Promise<unknown>;
    /** @go GitWorktreeMergeApply(dir string, name string, baseSha string, paths []string) → (*GitWorktreeMergeApplyResult, error) // 待补: GitWorktreeMergeApplyResult */
    GitWorktreeMergeApply(dir: string, name: string, baseSha: string, paths: string[]): Promise<unknown>;
    /** @go GitWorktreeMergePreview(dir string, name string, baseSha string) → (*GitWorktreeMergePreviewResult, error) // 待补: GitWorktreeMergePreviewResult */
    GitWorktreeMergePreview(dir: string, name: string, baseSha: string): Promise<unknown>;
    GitWorktreePrune(dir: string): Promise<void>;
    GitWorktreeRemove(dir: string, name: string, deleteBranch: boolean): Promise<void>;
    GitWorktreeSnapshotPatch(dir: string, name: string, baseSha: string): Promise<string>;
    GitWorktreeStat(dir: string, name: string, baseSha: string): Promise<string>;
    /** @go GroupLeaseAcquire(ctx context.Context, id string, label string) → (GroupLeaseStatus, error) // 待补: GroupLeaseStatus */
    GroupLeaseAcquire(id: string, label: string): Promise<unknown>;
    GroupLeaseRelease(id: string): Promise<void>;
    GroupLeaseReleaseByOwner(owner: string): Promise<number>;
    /** @go GroupLeaseStatus(id string) → (GroupLeaseStatus, error) // 待补: GroupLeaseStatus */
    GroupLeaseStatus(id: string): Promise<unknown>;
    /** @go ImportPluginFromZip(ctx context.Context) → (*plugins.PluginInfo, error) // 待补: PluginInfo */
    ImportPluginFromZip(): Promise<unknown>;
    InstallPluginFromUrl(rawUrl: string): Promise<PluginInfo | null>;
    IsAIFloatWindow(): Promise<boolean>;
    IsDebugConsoleWindow(): Promise<boolean>;
    IsTerminalWindow(): Promise<boolean>;
    IsWorkspaceOpen(dir: string): Promise<boolean>;
    /** @go ListLangPackages(kind string, scope string, target string) → (*LangPackageList, error) // 待补: LangPackageList */
    ListLangPackages(kind: string, scope: string, target: string): Promise<unknown>;
    /** @go ListTimers() → ([]aitimer.Info, error) // 待补: Info */
    ListTimers(): Promise<unknown[]>;
    LogFrontend(level: string, message: string): Promise<void>;
    /** @go MCPCallTool(publicName string, args string) → (CallResult, error) // 待补: CallResult */
    MCPCallTool(publicName: string, args: string): Promise<unknown>;
    /** @go MCPDesktopDoctor() → (DoctorResult) // 待补: DoctorResult */
    MCPDesktopDoctor(): Promise<unknown>;
    /** @go MCPDesktopInstall() → (InstallResult) // 待补: InstallResult */
    MCPDesktopInstall(): Promise<unknown>;
    /** @go MCPDesktopInstallStart() → (InstallStartResult) // 待补: InstallStartResult */
    MCPDesktopInstallStart(): Promise<unknown>;
    /** @go MCPDesktopInstallStatus() → (map[string]any) */
    MCPDesktopInstallStatus(): Promise<Record<string, unknown>>;
    /** @go MCPDesktopPlan() → (Plan) // 待补: Plan */
    MCPDesktopPlan(): Promise<unknown>;
    /** @go MCPGetConfig() → (MCPConfig, error) // 待补: MCPConfig */
    MCPGetConfig(): Promise<unknown>;
    /** @go MCPInstallSample(id string) → (map[string]interface{}, error) */
    MCPInstallSample(id: string): Promise<Record<string, unknown>>;
    /** @go MCPListServerTools(name string) → ([]RemoteTool, error) // 待补: RemoteTool */
    MCPListServerTools(name: string): Promise<unknown[]>;
    /** @go MCPProbeServer(name string, cfg MCPServerConfig) → (ProbeResult, error) // 待补: MCPServerConfig, ProbeResult */
    MCPProbeServer(name: string, cfg: unknown): Promise<unknown>;
    MCPRestartServer(name: string): Promise<void>;
    /** @go MCPSamplesList() → ([]MCPSampleInfo, error) // 待补: MCPSampleInfo */
    MCPSamplesList(): Promise<unknown[]>;
    MCPSetServerEnabled(name: string, enabled: boolean): Promise<void>;
    /** @go MCPSnapshot() → (Snapshot) // 待补: Snapshot */
    MCPSnapshot(): Promise<unknown>;
    /** @go MCPWriteConfig(cfg MCPConfig) → (error) // 待补: MCPConfig */
    MCPWriteConfig(cfg: unknown): Promise<void>;
    /** @go MarkTimer(id string, note string) → (aitimer.Info, error) // 待补: Info */
    MarkTimer(id: string, note: string): Promise<unknown>;
    MavenData(workspaceRoot: string, mvnPath: string, timeoutMs: number, kind: string, moduleRelPath: string): Promise<string>;
    /** @go MavenProjectInfo(root string) → (*ProjectInfo, error) // 待补: ProjectInfo */
    MavenProjectInfo(root: string): Promise<unknown>;
    /** @go MemoLeaseAcquire(ctx context.Context, scope string, workspace string, label string) → (LeaseStatus, error) // 待补: LeaseStatus */
    MemoLeaseAcquire(scope: string, workspace: string, label: string): Promise<unknown>;
    MemoLeaseRelease(scope: string, workspace: string): Promise<void>;
    /** @go MemoLeaseStatus(scope string, workspace string) → (LeaseStatus, error) // 待补: LeaseStatus */
    MemoLeaseStatus(scope: string, workspace: string): Promise<unknown>;
    MemoLoad(scope: string, workspace: string): Promise<string>;
    /** @go MemoSave(scope string, workspace string, doc string, baseMtimeMs int64) → (SaveResult) // 待补: SaveResult */
    MemoSave(scope: string, workspace: string, doc: string, baseMtimeMs: number): Promise<unknown>;
    MemoSaveImage(scope: string, workspace: string, dataURL: string): Promise<string>;
    MemoUnwatch(scope: string, workspace: string): Promise<void>;
    MemoWatch(scope: string, workspace: string): Promise<void>;
    MoveEntry(src: string, destDir: string, newName: string): Promise<string>;
    NotifyAttention(beep: boolean): Promise<void>;
    NotifySystemToast(title: string, body: string, payload: string, silent: boolean): Promise<void>;
    OpenAIFloatWindow(root: string): Promise<void>;
    OpenDebugConsoleWindow(): Promise<void>;
    OpenDevTools(): Promise<void>;
    OpenDiffWindow(pathA: string, pathB: string): Promise<void>;
    OpenDirInNewWindow(dir: string): Promise<void>;
    /** @go OpenFile(path string, enc string) → (*FileData, error) // 待补: FileData */
    OpenFile(path: string, enc: string): Promise<unknown>;
    OpenFilesDialog(): Promise<string[]>;
    OpenFolderDialog(defaultDir: string): Promise<string>;
    OpenInNewWindows(paths: string[]): Promise<void>;
    OpenLightView(path: string): Promise<void>;
    OpenLivePreview(path: string): Promise<void>;
    OpenLogDir(): Promise<void>;
    OpenNewWindow(): Promise<void>;
    OpenPluginsDir(): Promise<void>;
    OpenSettingsInMainWindow(pane: string): Promise<void>;
    OpenWithDefaultApp(path: string): Promise<void>;
    OpenWorkspaceForConversation(dir: string, sessionID: string): Promise<void>;
    /** @go ParseReadingDocx(path string) → (*ReadingDocx, error) // 待补: ReadingDocx */
    ParseReadingDocx(path: string): Promise<unknown>;
    /** @go PatchApply(planID string, files []string, hunks map[string][]int, mode string) → (*patch.PatchApplyResult, error) // 待补: PatchApplyResult */
    PatchApply(planID: string, files: string[], hunks: Record<string, number>, mode: string): Promise<unknown>;
    PatchDelete(id: string, root: string): Promise<void>;
    /** @go PatchList(root string, limit int) → ([]patch.PatchMeta, error) // 待补: PatchMeta */
    PatchList(root: string, limit: number): Promise<unknown[]>;
    /** @go PatchParseText(text string) → (*PatchPreview, error) // 待补: PatchPreview */
    PatchParseText(text: string): Promise<unknown>;
    /** @go PatchPreviewFile(path string, root string) → (*patch.PatchPreview, error) // 待补: PatchPreview */
    PatchPreviewFile(path: string, root: string): Promise<unknown>;
    /** @go PatchPreviewText(text string, root string) → (*patch.PatchPreview, error) // 待补: PatchPreview */
    PatchPreviewText(text: string, root: string): Promise<unknown>;
    PatchReadText(path: string): Promise<string>;
    /** @go PatchRepreview(planID string, allowOffset bool, ignoreWhitespace bool) → (*patch.PatchPreview, error) // 待补: PatchPreview */
    PatchRepreview(planID: string, allowOffset: boolean, ignoreWhitespace: boolean): Promise<unknown>;
    /** @go PatchRevert(patchID string, root string, onConflict string) → (*patch.PatchRevertResult, error) // 待补: PatchRevertResult */
    PatchRevert(patchID: string, root: string, onConflict: string): Promise<unknown>;
    /** @go PatchSave(root string, summary string, text string) → (*patch.PatchPreview, error) // 待补: PatchPreview */
    PatchSave(root: string, summary: string, text: string): Promise<unknown>;
    PatchStoreDir(root: string): Promise<string>;
    PopOutMemo(scope: string, workspace: string): Promise<void>;
    PopOutSession(sessionID: string, kind: string, workspace: string): Promise<void>;
    PopOutTerminal(termID: string): Promise<void>;
    /** @go PrepareReadingEpub(path string) → (*ReadingEpubBook, error) // 待补: ReadingEpubBook */
    PrepareReadingEpub(path: string): Promise<unknown>;
    /** @go PrepareRun(spec RunSpec) → (*RunWorkspace, error) // 待补: RunSpec, RunWorkspace */
    PrepareRun(spec: unknown): Promise<unknown>;
    QuitApp(): Promise<void>;
    ReadAudioDataURL(path: string): Promise<string>;
    /** @go ReadDir(path string, limit int) → (*DirListing, error) // 待补: DirListing */
    ReadDir(path: string, limit: number): Promise<unknown>;
    /** @go ReadDirTree(path string, depth int) → (*DirTreeListing, error) // 待补: DirTreeListing */
    ReadDirTree(path: string, depth: number): Promise<unknown>;
    ReadImageAsDataURL(path: string): Promise<string>;
    ReadPluginAsset(id: string, relPath: string): Promise<string>;
    /** @go ReadReadingEpubChapter(epubID string, index int) → (*ReadingEpubChapter, error) // 待补: ReadingEpubChapter */
    ReadReadingEpubChapter(epubID: string, index: number): Promise<unknown>;
    ReadVideoAsDataURL(path: string): Promise<string>;
    RegisterEventOwner(kind: string, id: string): Promise<void>;
    RegisterPreviewRoot(dir: string): Promise<string>;
    RenameEntry(path: string, newName: string): Promise<string>;
    /** @go ResolveRunShell(kind string) → (*RunShellInfo, error) // 待补: RunShellInfo */
    ResolveRunShell(kind: string): Promise<unknown>;
    ResolveSessionWorkspace(id: string): Promise<string>;
    RestoreEntry(path: string): Promise<void>;
    /** @go RunCommandSync(exe string, args []string, cwd string, timeoutMs int) → (*CommandResult, error) // 待补: CommandResult */
    RunCommandSync(exe: string, args: string[], cwd: string, timeoutMs: number): Promise<unknown>;
    RunEndInput(id: string): Promise<void>;
    RunExec(id: string, exe: string, args: string[], cwd: string, pathPrepend: string, timeoutMs: number): Promise<void>;
    RunInput(id: string, text: string): Promise<void>;
    RunStop(id: string): Promise<void>;
    RunningSessionCount(): Promise<number>;
    SQLClose(id: string): Promise<void>;
    /** @go SQLImport(path string, kind string, encoding string, text string, useText bool) → (SQLImportInfo, error) // 待补: SQLImportInfo */
    SQLImport(path: string, kind: string, encoding: string, text: string, useText: boolean): Promise<unknown>;
    /** @go SQLQuery(id string, query string, limit int) → (SQLResult, error) // 待补: SQLResult */
    SQLQuery(id: string, query: string, limit: number): Promise<unknown>;
    /** @go SandboxRevoke(root string) → (*GrantState, error) // 待补: GrantState */
    SandboxRevoke(root: string): Promise<unknown>;
    /** @go SandboxScan(root string) → (*GrantState, error) // 待补: GrantState */
    SandboxScan(root: string): Promise<unknown>;
    SaveDataURL(path: string, dataURL: string): Promise<void>;
    SaveFile(path: string, content: string, eol: string, hasBom: boolean, enc: string): Promise<void>;
    /** @go SaveFileChecked(path string, content string, eol string, hasBom bool, enc string, expectMtime string) → (*SaveFileResult, error) // 待补: SaveFileResult */
    SaveFileChecked(path: string, content: string, eol: string, hasBom: boolean, enc: string, expectMtime: string): Promise<unknown>;
    SaveFileDialog(defaultName: string): Promise<string>;
    /** @go ScanReadingRoot(root string, opts ReadingScanOptions) → (*ReadingScan, error) // 待补: ReadingScanOptions, ReadingScan */
    ScanReadingRoot(root: string, opts: unknown): Promise<unknown>;
    /** @go SearchReadingBook(requestID string, root string, query string, opts ReadingSearchOptions) → (*ReadingSearchResult, error) // 待补: ReadingSearchOptions, ReadingSearchResult */
    SearchReadingBook(requestID: string, root: string, query: string, opts: unknown): Promise<unknown>;
    /** @go SearchWorkspace(root string, query string, caseSensitive bool, maxResults int) → (*SearchResult, error) // 待补: SearchResult */
    SearchWorkspace(root: string, query: string, caseSensitive: boolean, maxResults: number): Promise<unknown>;
    /** @go SearchWorkspaceAdvanced(root string, query string, opts SearchOptions) → (*SearchResult, error) // 待补: SearchOptions, SearchResult */
    SearchWorkspaceAdvanced(root: string, query: string, opts: unknown): Promise<unknown>;
    /** @go SearchWorkspaceFiltered(root string, query string, caseSensitive bool, maxResults int, pattern string) → (*SearchResult, error) // 待补: SearchResult */
    SearchWorkspaceFiltered(root: string, query: string, caseSensitive: boolean, maxResults: number, pattern: string): Promise<unknown>;
    /** @go SearchWorkspaceFuzzy(root string, query string, caseSensitive bool, maxResults int) → (*SearchResult, error) // 待补: SearchResult */
    SearchWorkspaceFuzzy(root: string, query: string, caseSensitive: boolean, maxResults: number): Promise<unknown>;
    SetAIRunning(running: boolean): Promise<void>;
    SetAgentSkill(enabled: boolean): Promise<void>;
    SetCloseAction(action: string): Promise<void>;
    SetContextMenu(enabled: boolean): Promise<void>;
    SetDataSource(source: string): Promise<void>;
    SetDeveloperMode(enabled: boolean): Promise<void>;
    SetDirty(dirty: boolean): Promise<void>;
    SetEnvVarEncrypted(on: boolean): Promise<void>;
    /** @go SetEnvVars(inputs []EnvVarInput) → (error) // 待补: EnvVarInput */
    SetEnvVars(inputs: unknown[]): Promise<void>;
    SetFileAssociation(enabled: boolean): Promise<void>;
    SetOpenMode(mode: string): Promise<void>;
    SetPathRegistered(enabled: boolean): Promise<void>;
    SetPluginEnabled(id: string, enabled: boolean): Promise<void>;
    SetPluginsPathMode(mode: string): Promise<void>;
    SetWindowBg(r: number, g: number, b: number): Promise<void>;
    SetWindowCollapsed(collapsed: boolean): Promise<void>;
    ShowInFolder(path: string): Promise<void>;
    ShowOpenFileDialog(title: string, filter: string): Promise<string>;
    ShowSaveFileDialog(title: string, defaultName: string, filter: string): Promise<string>;
    StartCommand(id: string, exe: string, args: string[], cwd: string): Promise<void>;
    /** @go StartTimer(mode string, seconds int, label string) → (aitimer.StartResult, error) // 待补: StartResult */
    StartTimer(mode: string, seconds: number, label: string): Promise<unknown>;
    StopCommand(id: string): Promise<void>;
    /** @go StopTimer(id string) → (aitimer.StopResult, error) // 待补: StopResult */
    StopTimer(id: string): Promise<unknown>;
    /** @go StorageClear(ids []string, workspaceRoot string) → (storage.ClearReport, error) // 待补: ClearReport */
    StorageClear(ids: string[], workspaceRoot: string): Promise<unknown>;
    /** @go StorageScan(workspaceRoot string) → (storage.Report, error) // 待补: Report */
    StorageScan(workspaceRoot: string): Promise<unknown>;
    StructureDir(dir: string): Promise<string>;
    SuggestCopyName(dir: string, name: string, isDir: boolean): Promise<string>;
    /** @go SuggestReadingBooks(workspace string, limit int) → ([]ReadingBookSuggestion) // 待补: ReadingBookSuggestion */
    SuggestReadingBooks(workspace: string, limit: number): Promise<unknown[]>;
    TermClose(id: string): Promise<void>;
    TermCreate(cols: number, rows: number, shell: string, cwd: string): Promise<Record<string, string>>;
    /** @go TermList() → ([]TermInfo) // 待补: TermInfo */
    TermList(): Promise<unknown[]>;
    /** @go TermRead(id string, maxChars int) → (*TermReadResult, error) // 待补: TermReadResult */
    TermRead(id: string, maxChars: number): Promise<unknown>;
    TermResize(id: string, cols: number, rows: number): Promise<void>;
    TermShells(): Promise<Record<string, string>[]>;
    TermWrite(id: string, data: string): Promise<void>;
    UnregisterEventOwner(kind: string, id: string): Promise<void>;
    UnwatchAll(): Promise<void>;
    UnwatchWorkspace(): Promise<void>;
    UnwatchWorkspaceFor(owner: string): Promise<void>;
    UpdatePluginFromUrl(id: string, rawUrl: string): Promise<PluginInfo | null>;
    WatchWorkspace(root: string): Promise<void>;
    WatchWorkspaceFor(owner: string, root: string): Promise<void>;
    /** @go WebFetch(rawURL string, maxChars int) → (map[string]interface{}, error) */
    WebFetch(rawURL: string, maxChars: number): Promise<Record<string, unknown>>;
    /** @go WebFetchImage(rawURL string) → (map[string]interface{}, error) */
    WebFetchImage(rawURL: string): Promise<Record<string, unknown>>;
    /** @go WebSearch(query string, maxResults int) → (map[string]interface{}, error) */
    WebSearch(query: string, maxResults: number): Promise<Record<string, unknown>>;
    WebToolsConfigClearKey(): Promise<void>;
    /** @go WebToolsConfigGet() → (map[string]interface{}, error) */
    WebToolsConfigGet(): Promise<Record<string, unknown>>;
    /** @go WebToolsConfigSave(payload map[string]interface{}) → (error) */
    WebToolsConfigSave(payload: Record<string, unknown>): Promise<void>;
    WindowActivate(): Promise<void>;
    WindowFocusByName(name: string): Promise<boolean>;
    WindowList(): Promise<Record<string, string>[]>;
    WindowRegister(workspace: string): Promise<void>;
    WindowReuseForSession(workspace: string, sessionID: string): Promise<string>;
    WindowReuseResult(reqID: string, status: string): Promise<void>;
    WipeGuardAlarm(level: string, reason: string, detail: string): Promise<void>;
    /** @go WipeGuardBackup(call wipeguard.BackupCall) → (wipeguard.BackupResult, error) // 待补: BackupCall, BackupResult */
    WipeGuardBackup(call: unknown): Promise<unknown>;
    WipeGuardClear(): Promise<void>;
    /** @go WipeGuardCompare(before wipeguard.Fingerprint, after wipeguard.Fingerprint) → (wipeguard.Verdict) // 待补: Fingerprint, Verdict */
    WipeGuardCompare(before: unknown, after: unknown): Promise<unknown>;
    /** @go WipeGuardConfigure(settings wipeguard.Settings) → () // 待补: Settings */
    WipeGuardConfigure(settings: unknown): Promise<void>;
    /** @go WipeGuardFingerprint(ws string) → (wipeguard.Fingerprint) // 待补: Fingerprint */
    WipeGuardFingerprint(ws: string): Promise<unknown>;
    /** @go WipeGuardList(ws string) → ([]wipeguard.IndexRow, error) // 待补: IndexRow */
    WipeGuardList(ws: string): Promise<unknown[]>;
    WipeGuardRestore(entryID: string, ws: string): Promise<string>;
    /** @go WipeGuardSnapshot(ws string) → (wipeguard.SnapshotResult, error) // 待补: SnapshotResult */
    WipeGuardSnapshot(ws: string): Promise<unknown>;
    /** @go WipeGuardSnapshotList(ws string) → ([]wipeguard.SnapshotEntry, error) // 待补: SnapshotEntry */
    WipeGuardSnapshotList(ws: string): Promise<unknown[]>;
    WipeGuardSnapshotRestore(ws: string, name: string): Promise<string>;
    /** @go WipeGuardStatus(ws string) → (wipeguard.ModeInfo) // 待补: ModeInfo */
    WipeGuardStatus(ws: string): Promise<unknown>;
}

export type BackendMethod = keyof Backend;
