/**
 * 调试台（?dev=console）：第一层参数、变化率曲线、模型设置、片段详情、合并依据……
 * 逻辑都在 core/useHomi.ts，这里只负责显示。
 */
import { useEffect, useRef, useState } from 'react'
import { WebcamSource } from '../frame-source/webcam'
import { TEST_CLIPS, createClipSource } from '../dev/test-clips'
import { GRID_H, GRID_W, type Segment } from '../motion/detector'
import { DEFAULT_CONFIG } from '../motion/state-machine'
import { RatioChart } from '../components/RatioChart'
import { ConfigPanel } from '../components/ConfigPanel'
import { SegmentCard } from '../components/SegmentCard'
import { EventCard } from '../components/EventCard'
import { EventDebug } from '../components/EventDebug'
import { CategoryPanel } from '../components/CategoryPanel'
import { SetupSheet } from '../components/SetupSheet'
import { IgnoreZones } from '../components/IgnoreZones'
import { JudgeSettings } from '../components/JudgeSettings'
import { ModelPanel } from '../components/ModelPanel'
import { ContextPanel } from '../components/ContextPanel'
import { AlertBanner, requestNotifyPermission } from '../components/AlertBanner'
import { FeedbackSheet } from '../components/FeedbackSheet'
import { EufySheet } from '../components/EufySheet'
import { ReportPanel } from '../components/ReportPanel'
import { PendingList } from '../components/PendingList'
import type { HomiEvent } from '../events/grouping'
import { isSameDay } from '../store/retention'
import { fallRuleOn } from '../memory/types'
import { useHomi, clockOf } from '../core/useHomi'

const PHASE_LABEL = { idle: '静止', motion: '运动中', cooldown: '冷却' } as const

const mmss = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function ConsolePage() {
  const {
    role,
    mirrorFrame,
    syncMismatch,
    sourceName,
    config,
    setConfig,
    zones,
    setZones,
    editingZones,
    setEditingZones,
    showMask,
    setShowMask,
    version,
    samplesRef,
    previewRef,
    maskRef,
    source,
    running,
    error,
    run,
    stop,
    startWebcam,
    startVideo,
    startEufy,
    connectEufy: connectCloudEufy,
    recording,
    startRecording,
    stopRecording,
    policy,
    setPolicy,
    concurrency,
    setConcurrency,
    segments,
    analyses,
    keyFrames,
    fallWatches,
    runAnalysis,
    selectedId,
    setSelectedId,
    selectedEventId,
    setSelectedEventId,
    homeCtx,
    setHomeCtx,
    setup,
    setSetup,
    finishSetup,
    saveDraft,
    recordVote,
    feedbackLog,
    alerts,
    dismissAlert,
    markFalseAlarm,
    endPlan,
    events,
    consolidation,
    consolidate,
    report,
    generateReport,
    snapOf,
    linksOf,
    leftOf,
    earlierDays,
    pending,
    markDone,
    answering,
    setAnswering,
    answerAlert,
    answeringSeg,
    answeringJudgment,
    storage,
    deleteAll,
  } = useHomi()
  const fileRef = useRef<HTMLInputElement>(null)
  const [eufyOpen, setEufyOpen] = useState(false)
  // eufy：云端配好了参数就直接连；没配才弹出设置框（设置框也可以手动改一次）
  const connectEufy = async () => {
    if (!(await connectCloudEufy())) setEufyOpen(true)
  }
  useEffect(() => {
    document.title = 'Porchlight 调试台'
  }, [])


  const eventGroup = (ev: HomiEvent) => {
    const segs = ev.segmentIds.map((id) => segments.find((s) => s.id === id)).filter((s): s is Segment => !!s)
    return segs.length ? (
      <EventCard
        key={ev.id}
        event={ev}
        categories={homeCtx.categories}
        segments={segs}
        judgmentOf={(id) => analyses[id]?.final ?? analyses[id]?.shown}
        snapOf={snapOf}
        left={leftOf(ev) ?? undefined}
        links={linksOf(ev)}
        selected={selectedEventId === ev.id}
        onSelect={() => setSelectedEventId(ev.id)}
        renderSegment={segmentCard}
      />
    ) : null
  }
  const segmentCard = (s: Segment) => (
    <SegmentCard
      key={s.id}
      segment={s}
      analysis={analyses[s.id]}
      fallWatch={fallWatches[s.id]}
      keyFrames={keyFrames[s.id]}
      selected={selectedId === s.id}
      onSelect={() => setSelectedId(s.id)}
      onRejudge={() => runAnalysis(s)}
      ctx={homeCtx}
      onVote={(v) => recordVote(s.id, v)}
      onSaveDraft={(d, note) => saveDraft(s.id, d, note)}
    />
  )

  const selectedSegment = segments.find((s) => s.id === selectedId) ?? null
  const last = samplesRef.current.at(-1)
  const phase = running ? (last?.phase ?? 'idle') : null

  return (
    <div className="app">
      {eufyOpen && (
        <EufySheet
          onClose={() => setEufyOpen(false)}
          onConnect={(c) => {
            setEufyOpen(false)
            void startEufy(c)
          }}
        />
      )}
      {setup === null && <SetupSheet initial={{ fallAlert: fallRuleOn(homeCtx) }} onDone={finishSetup} />}
      <header className="topbar">
        <div>
          <h1>Porchlight 调试台</h1>
          <p>
            第一层：运动检测 → 片段 · 第二层：模型 + 记忆判断 · 帧来源：{sourceName ?? '未开启'}
            {role === 'mirror' && (
              <span className="role-badge">云端：Homi 在云端运行{source ? '，这个页面在上传画面' : '，这里实时显示它的过程'}</span>
            )}
            {role === 'starting' && <span className="role-badge">正在连接云端…</span>}
          </p>
        </div>
        <div className="topbar-actions">
          {source instanceof WebcamSource &&
            (recording ? (
              <button className="btn rec" onClick={stopRecording}>
                ● 停止录制 {mmss(Date.now() - recording.startedAt)}
              </button>
            ) : (
              <button className="btn" onClick={startRecording} title="录成 .webm，之后可用「视频文件」反复测试">
                录制
              </button>
            ))}
          {running ? (
            <button className="btn" onClick={stop}>停止</button>
          ) : (
            <>
              <select
                className="clip-select"
                value=""
                title="开发用：UR 摔倒数据集的测试片段"
                onChange={(e) => {
                  const c = TEST_CLIPS.find((x) => x.id === e.target.value)
                  if (c) void run(createClipSource(c), (err) => (err as Error).message)
                }}
              >
                <option value="">测试片段…</option>
                {TEST_CLIPS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
              <button className="btn" onClick={() => fileRef.current?.click()}>视频文件</button>
              <button className="btn primary" onClick={startWebcam}>开启摄像头</button>
              <button className="btn primary" onClick={() => void connectEufy()} title="用云端配好的参数连接">eufy 摄像头</button>
              <button className="btn" onClick={() => setEufyOpen(true)} title="手动填 / 改 eufy 参数">eufy 设置</button>
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void startVideo(f)
            }}
          />
        </div>
      </header>

      {error && <div className="error" role="alert">{error}</div>}
      {syncMismatch && <div className="error" role="alert">有 Porchlight 页面是旧版本，请把所有 Porchlight 页面都刷新一下。</div>}

      <AlertBanner
        alerts={alerts}
        canLookNow={running}
        onDismiss={dismissAlert}
        onEndPlan={endPlan}
        onFalseAlarm={markFalseAlarm}
        onLookNow={() => previewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
        onAnswer={(a) => answerAlert(a)}
        onShowSegment={(id) => {
          setSelectedId(id)
          document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }}
      />

      <main className="layout">
        <div className="col-main">
          <section className="panel">
            <div className="preview" ref={previewRef}>
              {role === 'mirror' && running && !source && mirrorFrame && <img className="mirror-frame" src={mirrorFrame} alt="另一个页面的画面" />}
              <canvas ref={maskRef} width={GRID_W} height={GRID_H} className="mask" />
              <IgnoreZones zones={zones} editing={editingZones} onChange={setZones} />
              {!running && !editingZones && (
                <div className="placeholder">开启摄像头，或选择一个视频文件开始检测</div>
              )}
              {phase && <span className={`phase phase-${phase}`}>{PHASE_LABEL[phase]}</span>}
            </div>
            <div className="chart-head">
              <span>
                帧间变化率 <b>{last ? `${(last.ratio * 100).toFixed(1)}%` : '—'}</b>
              </span>
              <span className="chart-tools">
                <label className="check">
                  <input type="checkbox" checked={showMask} onChange={(e) => setShowMask(e.target.checked)} />
                  叠加变化区域
                </label>
                <button className={`btn small ${editingZones ? 'primary' : ''}`} onClick={() => setEditingZones((v) => !v)}>
                  {editingZones ? '完成' : '忽略区域'}
                  {zones.length > 0 && !editingZones && ` (${zones.length})`}
                </button>
                {editingZones && zones.length > 0 && (
                  <button className="link" onClick={() => setZones([])}>全部清除</button>
                )}
              </span>
            </div>
            {editingZones && (
              <p className="zones-note">
                框内的画面不参与运动检测；送给模型的图里这些区域会裁掉或填灰（不进模型），你在这里看到的图是完整的。
              </p>
            )}
            <RatioChart samples={samplesRef.current} threshold={config.areaThreshold} version={version} />
            <p className="legend">
              <i className="lg-line" /> 变化率 <i className="lg-dash" /> 面积阈值 <i className="lg-motion" /> 片段进行中
            </p>
          </section>

          <ReportPanel
            report={report.data}
            running={report.running}
            error={report.error}
            events={events.filter((e) => isSameDay(e.startedAt, Date.now()))}
            categories={homeCtx.categories}
            onGenerate={() => void generateReport('manual')}
            renderEvent={(ev) => (
              <EventCard
                event={ev}
                categories={homeCtx.categories}
                segments={ev.segmentIds.map((id) => segments.find((s) => s.id === id)).filter((s): s is Segment => !!s)}
                judgmentOf={(id) => analyses[id]?.final}
                snapOf={snapOf}
                left={leftOf(ev) ?? undefined}
                links={linksOf(ev)}
              />
            )}
          />

          <section className="panel">
            <div className="panel-head">
              <h2>
                事件 <small>{events.length}</small> · 片段 <small>{segments.length}</small>
                {feedbackLog.length > 0 && <small> · 反馈记录 {feedbackLog.length}</small>}
              </h2>
              <span className="panel-actions">
                <button
                  className="btn small"
                  onClick={() => void consolidate('manual')}
                  disabled={consolidation.running || events.length === 0}
                  title={consolidation.note || '把今天的事件统一整理一遍：合并隔得远的同一件事、关联前后有关的事、确认分类'}
                >
                  {consolidation.running ? '整理中…' : '整理一下'}
                </button>
                {consolidation.at && !consolidation.running && (
                  <small className="muted">上次整理 {clockOf(consolidation.at)}</small>
                )}
                {(segments.length > 0 || events.length > 0 || report.data) && (
                  <button className="link" onClick={() => void deleteAll()}>
                    删除所有记录
                  </button>
                )}
              </span>
            </div>
            {consolidation.at && consolidation.note && <p className="muted small">{consolidation.note}</p>}
            {(consolidation.at || report.data) && (
              <PendingList items={pending} onDone={markDone} onAnswer={setAnswering} />
            )}
            {answering && answeringSeg && answeringJudgment && (
              <FeedbackSheet
                kind="other"
                event={answeringSeg}
                judgment={answeringJudgment}
                ctx={homeCtx}
                onClose={() => setAnswering(null)}
                onSave={(d, note) => {
                  const r = saveDraft(answeringSeg.id, d, note)
                  if (r.ok) markDone(answering.key)
                  return r
                }}
              />
            )}
            {segments.length === 0 ? (
              <p className="empty">还没有片段。在镜头前放下或拿走一样东西试试。</p>
            ) : (
              <>
                {/* 还没归入事件的片段（分析中 / 等前面的片段先合并）放最上面 */}
                {segments.filter((s) => !events.some((e) => e.segmentIds.includes(s.id))).map(segmentCard)}
                {[...events]
                  .reverse()
                  .filter((ev) => isSameDay(ev.startedAt, Date.now()))
                  .map(eventGroup)}
                {/* 更早的记录（本机保留 7 天），按天收起 */}
                {earlierDays.map(([day, evs]) => (
                  <details key={day} className="earlier-day">
                    <summary>
                      {day} · {evs.length} 件事
                    </summary>
                    {evs.map(eventGroup)}
                  </details>
                ))}
              </>
            )}
          </section>
        </div>

        <aside className="col-side">
          <ConfigPanel
            config={config}
            onChange={(patch) => setConfig((c) => ({ ...c, ...patch }))}
            onReset={() => setConfig(DEFAULT_CONFIG)}
          />
          <JudgeSettings
            policy={policy}
            onPolicy={setPolicy}
            concurrency={concurrency}
            onConcurrency={setConcurrency}
            analyses={Object.values(analyses).filter((a) => a.source !== 'restored')}
            selected={selectedSegment ? { label: `片段 ${clockOf(selectedSegment.startedAt)}`, analysis: analyses[selectedSegment.id] } : null}
            onReanalyze={() => selectedSegment && runAnalysis(selectedSegment)}
          />
          <ModelPanel />
          <ContextPanel
            ctx={homeCtx}
            onChange={setHomeCtx}
            onAdded={(d) => d.intent === 'plan_add' && d.planKind === 'expect' && requestNotifyPermission()}
          />
          <EventDebug event={events.find((e) => e.id === selectedEventId) ?? null} />
          <CategoryPanel categories={homeCtx.categories} />
          <p className="note">
            第一层检测用的画面不保存；最近的片段在本页内存里留全部截图（调试用），刷新后只剩关键图。送模型判断时，该片段的截图会经本机代理发送到主办方
            AI 网关，忽略区域裁掉或填灰。录制的视频直接下载到你的电脑，不上传。参数保存在本浏览器。
            事件、片段的关键图和日报保存在这台电脑的浏览器里（事件 7 天、日报 30 天，没被选中的截图不保存）
            {storage.usage !== null && `，目前约占 ${(storage.usage / 1024 / 1024).toFixed(1)} MB`}。
            {storage.note && ` ${storage.note}。`}{' '}
            <button className="link" onClick={() => setSetup(null)}>重新打开首次设置</button>
          </p>
        </aside>
      </main>
    </div>
  )
}

