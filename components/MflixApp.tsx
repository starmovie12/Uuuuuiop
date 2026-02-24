'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Bolt, Link as LinkIcon, Rocket, Loader2, RotateCcw, AlertTriangle, CircleCheck, History, ChevronRight, ChevronDown, Video, Film, Globe, Volume2, Sparkles, Home, Clock, CheckCircle2, XCircle, Trash2, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import LinkCard from '@/components/LinkCard';

interface LogEntry {
  msg: string;
  type: 'info' | 'success' | 'error' | 'warn';
}

interface Task {
  id: string;
  url: string;
  status: 'processing' | 'completed' | 'failed';
  createdAt: string;
  links: any[];
  error?: string;
  preview?: {
    title: string;
    posterUrl: string | null;
  };
  metadata?: {
    quality: string;
    languages: string;
    audioLabel: string;
  };
}

// =============================================
// Tab types for bottom navigation
// =============================================
type TabType = 'home' | 'processing' | 'completed' | 'failed' | 'history';

// =============================================
// 12-hour time format helper
// =============================================
function formatTime12h(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    return date.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return isoString;
  }
}

// =============================================
// Link stats calculator (used for non-streaming tasks)
// =============================================
function getLinkStats(links: any[]): { total: number; done: number; failed: number; pending: number } {
  if (!links || links.length === 0) return { total: 0, done: 0, failed: 0, pending: 0 };
  let done = 0, failed = 0, pending = 0;
  for (const link of links) {
    const s = (link.status || '').toLowerCase();
    if (s === 'done' || s === 'success') done++;
    else if (s === 'error' || s === 'failed') failed++;
    else pending++;
  }
  return { total: links.length, done, failed, pending };
}

export default function MflixApp() {
  const [url, setUrl] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  // Active tab state
  const [activeTab, setActiveTab] = useState<TabType>('home');

  // Live stream state
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<Record<number, LogEntry[]>>({});
  const [liveLinks, setLiveLinks] = useState<Record<number, string | null>>({});
  const [liveStatuses, setLiveStatuses] = useState<Record<number, string>>({});

  // Deleting / Retrying state
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [retryingTaskId, setRetryingTaskId] = useState<string | null>(null);

  // Track which tasks we've already auto-started streams for (prevent duplicate streams)
  const streamStartedRef = useRef<Set<string>>(new Set());

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchTasks();
    pollRef.current = setInterval(fetchTasks, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // ==========================================================================
  // BUG B FIX: fetchTasks now PROTECTS live-streaming task data from being
  // overwritten by stale Firestore data. During an active stream, the task
  // for that stream is NOT replaced by Firestore data — only non-streaming
  // tasks get updated. This prevents "ghost reversions" where completed links
  // randomly revert to "Queued for processing..." or "Processing...".
  // ==========================================================================
  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) {
        const text = await res.text();
        if (text.includes("Rate exceeded")) return;
        throw new Error(`Server error: ${res.status}`);
      }
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        setTasks(prevTasks => {
          // Read from the ref to know which tasks are currently streaming.
          // This avoids stale closure issues with activeTaskId state.
          const currentlyStreamingIds = streamStartedRef.current;

          if (currentlyStreamingIds.size === 0) {
            // No active streams — safe to replace everything with fresh Firestore data
            return data;
          }

          // Merge strategy: for streaming tasks, keep the previous local state;
          // for everything else, use fresh Firestore data.
          return data.map((serverTask: Task) => {
            if (currentlyStreamingIds.has(serverTask.id)) {
              // Find the existing local task to preserve its state
              const localTask = prevTasks.find(t => t.id === serverTask.id);
              if (localTask) {
                return localTask; // Keep local state — don't overwrite with stale Firestore
              }
            }
            return serverTask; // Use fresh Firestore data for non-streaming tasks
          });
        });
      }
    } catch (e) {
      console.error('Failed to fetch tasks:', e);
    }
  };

  // ==========================================================================
  // BUG A FIX: getEffectiveStats computes counter values from the LIVE
  // liveStatuses state during streaming, instead of from the stale task.links
  // array. This means the 4 counter badges (Total, Done, Failed, Pending)
  // update in real-time as each SSE event comes in.
  // ==========================================================================
  const getEffectiveStats = useCallback((task: Task): { total: number; done: number; failed: number; pending: number } => {
    const isLive = activeTaskId === task.id;

    if (!isLive) {
      // Not streaming — use Firestore data as-is
      return getLinkStats(task.links);
    }

    // Streaming: build stats from liveStatuses for ALL link indices
    const total = task.links.length;
    let done = 0, failed = 0, pending = 0;

    for (let i = 0; i < total; i++) {
      const liveStatus = liveStatuses[i];
      if (liveStatus) {
        const s = liveStatus.toLowerCase();
        if (s === 'done' || s === 'success') done++;
        else if (s === 'error' || s === 'failed') failed++;
        else pending++; // 'processing' etc.
      } else {
        // No live status for this index — check the original link status
        const origStatus = (task.links[i]?.status || '').toLowerCase();
        if (origStatus === 'done' || origStatus === 'success') done++;
        else if (origStatus === 'error' || origStatus === 'failed') failed++;
        else pending++;
      }
    }

    return { total, done, failed, pending };
  }, [activeTaskId, liveStatuses]);

  /**
   * Stream the solving process in real-time via SSE (NDJSON)
   *
   * KEY FIXES applied here:
   * 1. Only sends 'pending' links to stream_solve (skip already done/error)
   * 2. Uses streamStartedRef to prevent duplicate streams
   * 3. Properly handles all link states in the UI during streaming
   * 4. Cleanup in finally block ensures state is always reset
   * 5. BUG A FIX: Each SSE event updates liveStatuses so counters react in real-time
   * 6. BUG B FIX: streamStartedRef blocks fetchTasks from overwriting streaming task
   */
  const startLiveStream = useCallback(async (taskId: string, links: any[]) => {
    // Guard: Don't start if already streaming this task
    if (streamStartedRef.current.has(taskId)) {
      console.log('[Stream] Already streaming task ' + taskId + ', skipping');
      return;
    }

    // Only process links that are actually pending
    const pendingLinks = links
      .map((l: any, idx: number) => ({ ...l, _originalIdx: idx }))
      .filter((l: any) => {
        const s = (l.status || '').toLowerCase();
        return s === 'pending' || s === 'processing' || s === '';
      });

    if (pendingLinks.length === 0) {
      console.log('[Stream] No pending links for task ' + taskId + ', skipping stream');
      return;
    }

    console.log('[Stream] Starting stream for task ' + taskId + ' with ' + pendingLinks.length + ' pending links');
    streamStartedRef.current.add(taskId);
    setActiveTaskId(taskId);

    // Initialize live state for ALL links so UI shows correctly
    const initialLogs: Record<number, LogEntry[]> = {};
    const initialLinks: Record<number, string | null> = {};
    const initialStatuses: Record<number, string> = {};

    links.forEach((link: any, idx: number) => {
      const s = (link.status || '').toLowerCase();
      if (s === 'done' || s === 'success') {
        initialLogs[idx] = link.logs || [];
        initialLinks[idx] = link.finalLink || null;
        initialStatuses[idx] = 'done';
      } else if (s === 'error' || s === 'failed') {
        initialLogs[idx] = [{ msg: '🔄 Retrying...', type: 'info' }];
        initialLinks[idx] = null;
        initialStatuses[idx] = 'processing';
      } else {
        initialLogs[idx] = [];
        initialLinks[idx] = null;
        initialStatuses[idx] = 'processing';
      }
    });

    setLiveLogs(initialLogs);
    setLiveLinks(initialLinks);
    setLiveStatuses(initialStatuses);

    try {
      // Send pending links with their ORIGINAL index so the UI maps correctly
      const linksToSend = pendingLinks.map((l: any) => ({
        id: l._originalIdx,
        name: l.name,
        link: l.link,
      }));

      console.log('[Stream] POST /api/stream_solve with ' + linksToSend.length + ' links');

      const response = await fetch('/api/stream_solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          links: linksToSend,
          taskId
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('[Stream] stream_solve returned ' + response.status + ': ' + errText);
        setLiveStatuses(prev => {
          const updated = { ...prev };
          pendingLinks.forEach((l: any) => {
            updated[l._originalIdx] = 'error';
          });
          return updated;
        });
        return;
      }

      if (!response.body) {
        console.error('[Stream] No response body from stream_solve');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const lid = data.id;

            // =================================================================
            // BUG A FIX: Always accumulate logs — never replace previous logs.
            // Using functional updater to avoid stale closure issues.
            // =================================================================
            if (data.msg && data.type) {
              setLiveLogs(prev => ({
                ...prev,
                [lid]: [...(prev[lid] || []), { msg: data.msg, type: data.type }]
              }));
            }

            if (data.final) {
              setLiveLinks(prev => ({ ...prev, [lid]: data.final }));
            }

            // =================================================================
            // BUG A FIX: Update liveStatuses on TERMINAL events ('done'/'error').
            // getEffectiveStats reads from liveStatuses, so the counter badges
            // will automatically re-render when this state changes.
            // =================================================================
            if (data.status === 'done' || data.status === 'error') {
              setLiveStatuses(prev => ({
                ...prev,
                [lid]: data.status
              }));
            }

            // 'finished' means the link processing is complete —
            // if we haven't set done/error yet, mark as error (safety net)
            if (data.status === 'finished') {
              setLiveStatuses(prev => {
                const currentStatus = prev[lid];
                // Only update if not already in a terminal state
                if (currentStatus !== 'done' && currentStatus !== 'error') {
                  return { ...prev, [lid]: 'error' };
                }
                return prev;
              });
            }
          } catch {
            // skip invalid JSON lines
          }
        }
      }
    } catch (e: any) {
      console.error('[Stream] Stream error:', e);
    } finally {
      // Always cleanup in finally block
      streamStartedRef.current.delete(taskId);
      // Fetch fresh Firestore data now that stream is done & data has been persisted
      setTimeout(fetchTasks, 2000);
      setActiveTaskId(null);
    }
  }, []);

  const startProcess = async () => {
    if (!url.trim()) {
      if (navigator.vibrate) navigator.vibrate(50);
      return;
    }

    setIsConnecting(true);
    setError(null);
    setIsDone(false);

    try {
      // Step 1: Create or merge task via POST /api/tasks
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() })
      });

      if (!response.ok) {
        const text = await response.text();
        if (text.includes("Rate exceeded")) {
          throw new Error("Server is busy (Rate Limit). Please wait a few seconds and try again.");
        }
        throw new Error(`Server error: ${response.status}`);
      }

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error("Received unexpected response format from server.");
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      setIsConnecting(false);
      setIsProcessing(true);

      // Step 2: Fetch the updated task list
      await fetchTasks();

      if (data.taskId) {
        setExpandedTask(data.taskId);
        setActiveTab('processing');

        // Always try to start stream for any task that has pending links.
        // startLiveStream itself will skip if no pending links exist.
        try {
          const taskRes = await fetch('/api/tasks');
          const taskResContentType = taskRes.headers.get("content-type");
          if (taskRes.ok && taskResContentType?.includes("application/json")) {
            const taskList = await taskRes.json();
            const newTask = taskList.find((t: any) => t.id === data.taskId);

            if (newTask && newTask.links && newTask.links.length > 0) {
              await startLiveStream(data.taskId, newTask.links);
            }
          }
        } catch (streamErr: any) {
          console.error('[startProcess] Failed to start stream:', streamErr);
        }
      }

      setUrl('');
      setIsProcessing(false);
      setIsDone(true);
      setTimeout(() => setIsDone(false), 3000);

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An error occurred');
      setIsConnecting(false);
      setIsProcessing(false);
    }
  };

  // =============================================
  // Delete a task
  // =============================================
  const handleDeleteTask = async (taskId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (deletingTaskId) return;

    setDeletingTaskId(taskId);
    try {
      const res = await fetch('/api/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete');
      }

      setTasks(prev => prev.filter(t => t.id !== taskId));
      if (expandedTask === taskId) setExpandedTask(null);
    } catch (err: any) {
      console.error('Delete failed:', err);
      setError(`Delete failed: ${err.message}`);
    } finally {
      setDeletingTaskId(null);
    }
  };

  // =============================================
  // Retry a failed task
  // =============================================
  const handleRetryTask = async (task: Task, e: React.MouseEvent) => {
    e.stopPropagation();
    if (retryingTaskId) return;

    setRetryingTaskId(task.id);
    try {
      // First delete the failed task
      await fetch('/api/tasks', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: task.id }),
      });

      // Re-submit the same URL via POST
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: task.url }),
      });

      if (!response.ok) throw new Error(`Server error: ${response.status}`);

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      await fetchTasks();

      if (data.taskId) {
        setExpandedTask(data.taskId);
        setActiveTab('processing');

        try {
          const taskRes = await fetch('/api/tasks');
          const taskResContentType = taskRes.headers.get("content-type");
          if (taskRes.ok && taskResContentType?.includes("application/json")) {
            const taskList = await taskRes.json();
            const newTask = taskList.find((t: any) => t.id === data.taskId);
            if (newTask?.links?.length > 0) {
              await startLiveStream(data.taskId, newTask.links);
            }
          }
        } catch (streamErr: any) {
          console.error('[handleRetryTask] Failed to start stream:', streamErr);
        }
      }
    } catch (err: any) {
      console.error('Retry failed:', err);
      setError(`Retry failed: ${err.message}`);
    } finally {
      setRetryingTaskId(null);
    }
  };

  /**
   * Get effective logs/links/statuses: prefer live data if streaming, else use Firebase data
   */
  const getEffectiveLinkData = (task: Task, linkIdx: number, link: any) => {
    const isLive = activeTaskId === task.id;
    return {
      logs: isLive ? (liveLogs[linkIdx] || []) : (link.logs || []),
      finalLink: isLive ? (liveLinks[linkIdx] || link.finalLink || null) : (link.finalLink || null),
      status: isLive ? (liveStatuses[linkIdx] || 'processing') : (link.status || 'done'),
    };
  };

  // =============================================
  // Filter tasks based on active tab
  // =============================================
  const getFilteredTasks = (): Task[] => {
    switch (activeTab) {
      case 'processing':
        return tasks.filter(t => t.status === 'processing');
      case 'completed':
        return tasks.filter(t => t.status === 'completed');
      case 'failed':
        return tasks.filter(t => t.status === 'failed');
      case 'history':
        return [...tasks].sort((a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      case 'home':
      default:
        return tasks;
    }
  };

  const filteredTasks = getFilteredTasks();

  const tabLabels: Record<TabType, string> = {
    home: 'Home',
    processing: 'Processing',
    completed: 'Completed',
    failed: 'Failed',
    history: 'History',
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 pb-28">
      {/* Header */}
      <header className="flex justify-between items-center mb-8">
        <div className="text-2xl font-bold bg-gradient-to-br from-white to-slate-400 bg-clip-text text-transparent flex items-center gap-2">
          <Bolt className="text-indigo-500 fill-indigo-500" />
          MFLIX PRO
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          LIVE ENGINE
        </div>
      </header>

      {/* Input Section — always visible on Home tab */}
      {activeTab === 'home' && (
        <section className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2rem] p-6 mb-8 shadow-2xl">
          <div className="relative mb-4">
            <LinkIcon className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 w-5 h-5" />
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && startProcess()}
              placeholder="Paste Movie URL here..."
              className="w-full bg-black/40 border border-white/10 text-white pl-12 pr-4 py-4 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/20 transition-all font-sans"
            />
          </div>

          <button
            onClick={startProcess}
            disabled={isConnecting || isProcessing || isDone}
            className={`w-full py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all duration-300 shadow-lg active:scale-95 ${
              isDone
                ? 'bg-emerald-500 text-white'
                : error
                  ? 'bg-rose-500 text-white'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-800 disabled:opacity-70'
            }`}
          >
            {isConnecting ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                CONNECTING...
              </>
            ) : isProcessing ? (
              <>
                <RotateCcw className="w-5 h-5 animate-spin" />
                PROCESSING LIVE...
              </>
            ) : isDone ? (
              <>
                <CircleCheck className="w-5 h-5" />
                ALL DONE ✅
              </>
            ) : error ? (
              <>
                <AlertTriangle className="w-5 h-5" />
                ERROR - RETRY
              </>
            ) : (
              <>
                START ENGINE
                <Rocket className="w-5 h-5" />
              </>
            )}
          </button>

          {error && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm flex items-center gap-3"
            >
              <AlertTriangle className="w-5 h-5 flex-shrink-0" />
              <p className="flex-1">{error}</p>
              <button onClick={() => setError(null)} className="text-xs font-bold uppercase hover:text-rose-300">Dismiss</button>
            </motion.div>
          )}
        </section>
      )}

      {/* Global error banner (visible on non-home tabs) */}
      {activeTab !== 'home' && error && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm flex items-center gap-3"
        >
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <p className="flex-1">{error}</p>
          <button onClick={() => setError(null)} className="text-xs font-bold uppercase hover:text-rose-300">Dismiss</button>
        </motion.div>
      )}

      {/* Section Header */}
      <div className="mb-6 flex items-center gap-2 text-slate-400">
        {activeTab === 'processing' ? <Loader2 className="w-5 h-5 animate-spin" /> :
         activeTab === 'completed' ? <CheckCircle2 className="w-5 h-5" /> :
         activeTab === 'failed' ? <XCircle className="w-5 h-5" /> :
         activeTab === 'history' ? <History className="w-5 h-5" /> :
         <History className="w-5 h-5" />}
        <h3 className="font-bold uppercase tracking-wider text-sm">
          {activeTab === 'home' ? 'Recent Tasks' : `${tabLabels[activeTab]} Tasks`}
        </h3>
        <span className="ml-auto text-[10px] text-slate-600 font-mono">{filteredTasks.length} task{filteredTasks.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Tasks List */}
      <div className="space-y-4">
        {filteredTasks.map((task) => {
          // ===============================================================
          // BUG A FIX: Use getEffectiveStats instead of getLinkStats.
          // This reads from liveStatuses during streaming, so counters
          // update in real-time as SSE events arrive.
          // ===============================================================
          const stats = getEffectiveStats(task);
          return (
            <div key={task.id} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden transition-all hover:bg-white/[0.07]">
              <div
                className="p-4 flex items-center gap-4 cursor-pointer"
                onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
              >
                {/* Movie Poster Thumbnail */}
                <div className="w-12 h-16 bg-slate-800 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden border border-white/10">
                  {task.preview?.posterUrl ? (
                    <img
                      src={task.preview.posterUrl}
                      alt={task.preview?.title || 'Movie'}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                        (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                      }}
                    />
                  ) : null}
                  <Film className={`w-5 h-5 text-indigo-400 ${task.preview?.posterUrl ? 'hidden' : ''}`} />
                </div>

                <div className="flex-1 min-w-0">
                  <h4 className="font-bold text-sm text-white truncate">
                    {task.preview?.title || 'Processing...'}
                  </h4>
                  <p className="font-mono text-[10px] text-slate-500 truncate mt-0.5">{task.url}</p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                      task.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' :
                      task.status === 'failed' ? 'bg-rose-500/20 text-rose-400' :
                      'bg-indigo-500/20 text-indigo-400 animate-pulse'
                    }`}>
                      {task.status === 'processing' && activeTaskId === task.id ? '⚡ LIVE' : task.status}
                    </span>

                    <span className="text-slate-600 text-[10px]">{formatTime12h(task.createdAt)}</span>

                    {stats.total > 0 && (
                      <div className="flex items-center gap-1">
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-700/60 text-slate-300 font-mono">
                          {stats.total} links
                        </span>
                        {stats.done > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 font-mono">
                            ✓{stats.done}
                          </span>
                        )}
                        {stats.failed > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 font-mono">
                            ✗{stats.failed}
                          </span>
                        )}
                        {stats.pending > 0 && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 font-mono">
                            ⏳{stats.pending}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  {task.status === 'failed' && (
                    <button
                      onClick={(e) => handleRetryTask(task, e)}
                      disabled={retryingTaskId === task.id}
                      className="p-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 hover:bg-amber-500/20 transition-all disabled:opacity-50"
                      title="Retry this task"
                    >
                      {retryingTaskId === task.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                    </button>
                  )}

                  <button
                    onClick={(e) => handleDeleteTask(task.id, e)}
                    disabled={deletingTaskId === task.id}
                    className="p-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 transition-all disabled:opacity-50"
                    title="Delete this task"
                  >
                    {deletingTaskId === task.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>

                  {expandedTask === task.id ? <ChevronDown className="w-5 h-5 text-slate-500" /> : <ChevronRight className="w-5 h-5 text-slate-500" />}
                </div>
              </div>

              <AnimatePresence>
                {expandedTask === task.id && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="border-t border-white/5 bg-black/20"
                  >
                    {/* Movie Preview Banner */}
                    {task.preview?.posterUrl && (
                      <div className="relative h-32 overflow-hidden">
                        <img
                          src={task.preview.posterUrl}
                          alt={task.preview?.title || ''}
                          className="w-full h-full object-cover opacity-30 blur-sm"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 to-transparent" />
                        <div className="absolute bottom-3 left-4 right-4">
                          <h3 className="text-lg font-bold text-white truncate">{task.preview?.title}</h3>
                        </div>
                      </div>
                    )}

                    <div className="p-4">
                      {/* =============================================
                          MISSION 2 FIX: 4 Counter badges are now ABOVE
                          the 3 metadata boxes. Order swapped.
                          ============================================= */}

                      {/* Counter Badges — MOVED ABOVE metadata */}
                      {stats.total > 0 && (
                        <div className="grid grid-cols-4 gap-2 mb-4">
                          <div className="bg-slate-800/50 border border-white/5 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-slate-500 font-bold">Total</p>
                            <p className="text-lg font-bold text-white">{stats.total}</p>
                          </div>
                          <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-emerald-500 font-bold">Done</p>
                            <p className="text-lg font-bold text-emerald-400">{stats.done}</p>
                          </div>
                          <div className="bg-rose-500/5 border border-rose-500/10 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-rose-500 font-bold">Failed</p>
                            <p className="text-lg font-bold text-rose-400">{stats.failed}</p>
                          </div>
                          <div className="bg-amber-500/5 border border-amber-500/10 rounded-lg p-2 text-center">
                            <p className="text-[10px] uppercase text-amber-500 font-bold">Pending</p>
                            <p className="text-lg font-bold text-amber-400">{stats.pending}</p>
                          </div>
                        </div>
                      )}

                      {/* Metadata Boxes — NOW BELOW counter badges */}
                      {task.metadata && (
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                              <Sparkles className="w-3 h-3" />
                              Highest Quality
                            </label>
                            <p className="text-sm font-bold text-indigo-400">{task.metadata.quality || 'Unknown'}</p>
                          </div>
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                              <Globe className="w-3 h-3" />
                              Languages
                            </label>
                            <p className="text-sm font-bold text-emerald-400">{task.metadata.languages || 'Not Specified'}</p>
                          </div>
                          <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                            <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                              <Volume2 className="w-3 h-3" />
                              Audio Label
                            </label>
                            <p className="text-sm font-bold text-amber-400">{task.metadata.audioLabel || 'Unknown'}</p>
                          </div>
                        </div>
                      )}

                      {/* Processing State with Live Logs */}
                      {(task.status === 'processing' || activeTaskId === task.id) && (
                        <div className="space-y-3">
                          {task.links.map((link: any, idx: number) => {
                            const effective = getEffectiveLinkData(task, idx, link);
                            return (
                              <LinkCard
                                key={idx}
                                id={idx}
                                name={link.name}
                                logs={effective.logs}
                                finalLink={effective.finalLink}
                                status={effective.status as any}
                              />
                            );
                          })}
                          {task.links.length === 0 && (
                            <div className="flex flex-col items-center py-8 text-slate-400">
                              <Loader2 className="w-8 h-8 animate-spin mb-2" />
                              <p className="text-sm">Scraping in progress...</p>
                              <p className="text-xs opacity-50">You can close this window and return later.</p>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Failed State */}
                      {task.status === 'failed' && activeTaskId !== task.id && (
                        <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                          <AlertTriangle className="w-5 h-5 mb-2" />
                          {task.error || 'Task failed unexpectedly.'}
                        </div>
                      )}

                      {/* Completed State */}
                      {task.status === 'completed' && activeTaskId !== task.id && (
                        <div className="space-y-3">
                          {task.links.map((link: any, idx: number) => (
                            <LinkCard
                              key={idx}
                              id={idx}
                              name={link.name}
                              logs={link.logs || []}
                              finalLink={link.finalLink || null}
                              status={link.status || 'done'}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}

        {filteredTasks.length === 0 && (
          <div className="text-center py-12 text-slate-500 border-2 border-dashed border-white/5 rounded-3xl">
            <Rocket className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p>
              {activeTab === 'home'
                ? 'No tasks yet. Submit a URL to start!'
                : `No ${tabLabels[activeTab].toLowerCase()} tasks.`}
            </p>
          </div>
        )}
      </div>

      {/* =============================================
          Fixed Bottom Navigation Bar
          ============================================= */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-black/80 backdrop-blur-xl border-t border-white/10 safe-area-inset-bottom">
        <div className="max-w-2xl mx-auto flex items-stretch justify-around">
          {([
            { key: 'home' as TabType, icon: Home, label: 'Home' },
            { key: 'processing' as TabType, icon: Clock, label: 'Processing' },
            { key: 'completed' as TabType, icon: CheckCircle2, label: 'Completed' },
            { key: 'failed' as TabType, icon: XCircle, label: 'Failed' },
            { key: 'history' as TabType, icon: History, label: 'History' },
          ]).map(({ key, icon: Icon, label }) => {
            const isActive = activeTab === key;
            const count = key === 'processing' ? tasks.filter(t => t.status === 'processing').length :
                          key === 'completed' ? tasks.filter(t => t.status === 'completed').length :
                          key === 'failed' ? tasks.filter(t => t.status === 'failed').length :
                          key === 'history' ? tasks.length : 0;

            return (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`flex-1 flex flex-col items-center gap-0.5 py-3 px-1 transition-all relative ${
                  isActive
                    ? 'text-indigo-400'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {isActive && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-indigo-500 rounded-full" />
                )}
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {count > 0 && key !== 'home' && (
                    <span className={`absolute -top-1.5 -right-2.5 min-w-[16px] h-4 flex items-center justify-center text-[9px] font-bold rounded-full px-1 ${
                      key === 'failed' ? 'bg-rose-500 text-white' :
                      key === 'processing' ? 'bg-indigo-500 text-white' :
                      key === 'completed' ? 'bg-emerald-500 text-white' :
                      'bg-slate-600 text-white'
                    }`}>
                      {count}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-bold">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
