export const maxDuration = 60;

import { db } from '@/lib/firebaseAdmin';
import { solveHBLinks, solveHubCDN, solveHubDrive, solveHubCloudNative } from '@/lib/solvers';

// =============================================================================
// External API endpoints for solvers that need server-side processing.
// HubCloud is handled via HUBCLOUD_API_URL env var inside solvers.ts
// =============================================================================
const API_MAP = {
  timer: 'http://85.121.5.246:10000/solve?url=',
  hblinks: 'https://hblinks-dad.onrender.com/solve?url=',
  hubdrive: 'https://hdhub4u-1.onrender.com/solve?url=',
  // hubcloud: Now handled inside solveHubCloudNative() via HUBCLOUD_API_URL env var
  hubcdn_bypass: 'https://hubcdn-bypass.onrender.com/extract?url=',
};

export async function POST(req: Request) {
  let links: any[];
  let taskId: string | undefined;

  try {
    const body = await req.json();
    links = body.links;
    taskId = body.taskId;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!Array.isArray(links) || links.length === 0) {
    return new Response(JSON.stringify({ error: 'No links provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: any) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
        } catch {
          // Stream may have been closed by client
        }
      };

      const finalResults: Map<number, any> = new Map();

      const processLink = async (linkData: any, idx: number) => {
        const lid = linkData.id ?? idx; // Use ?? so id:0 works correctly
        let currentLink = linkData.link;
        const logs: { msg: string; type: string }[] = [];

        const sendLog = (msg: string, type: string = 'info') => {
          logs.push({ msg, type });
          send({ id: lid, msg, type });
        };

        const fetchWithUA = (url: string, options: any = {}) => {
          return fetch(url, {
            ...options,
            headers: {
              ...options.headers,
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });
        };

        try {
          sendLog('\uD83D\uDD0D Analyzing Link...', 'info');

          // Guard against missing/empty link
          if (!currentLink || typeof currentLink !== 'string') {
            sendLog('\u274C No link URL provided for this item', 'error');
            finalResults.set(lid, { ...linkData, status: 'error', error: 'No link URL', logs });
            return;
          }

          // --- HUBCDN.FANS BYPASS ---
          if (currentLink.includes('hubcdn.fans')) {
            sendLog('\u26A1 HubCDN Detected! Processing...', 'info');
            try {
              const r = await solveHubCDN(currentLink);
              if (r.status === 'success') {
                sendLog('\uD83C\uDF89 COMPLETED: Direct Link Found', 'success');
                send({ id: lid, final: r.final_link, status: 'done' });
                finalResults.set(lid, { ...linkData, finalLink: r.final_link, status: 'done', logs });
                return;
              } else throw new Error(r.message || 'HubCDN Native Failed');
            } catch (e: any) {
              sendLog(`\u274C HubCDN Error: ${e.message}`, 'error');
              finalResults.set(lid, { ...linkData, status: 'error', error: e.message, logs });
              return;
            }
          }

          // --- TIMER BYPASS ---
          const targetDomains = ['hblinks', 'hubdrive', 'hubcdn', 'hubcloud'];
          let loopCount = 0;

          while (loopCount < 3 && !targetDomains.some((d) => currentLink.includes(d))) {
            const isTimerPage = ['gadgetsweb', 'review-tech', 'ngwin', 'cryptoinsights'].some((x) =>
              currentLink.includes(x)
            );
            if (!isTimerPage && loopCount === 0) break;

            if (loopCount > 0) {
              sendLog('\uD83D\uDD04 Bypassing intermediate page: ' + currentLink, 'warn');
            } else {
              sendLog('\u23F3 Timer Detected. Processing...', 'warn');
            }

            try {
              sendLog('\u23F3 Calling External Timer API...', 'warn');
              const r = await fetchWithUA(API_MAP.timer + encodeURIComponent(currentLink)).then(
                (res) => res.json()
              );

              if (r.status === 'success') {
                currentLink = r.extracted_link!;
                sendLog('\u2705 Timer Bypassed', 'success');
                sendLog('\uD83D\uDD17 Link after Timer: ' + currentLink, 'info');
              } else {
                throw new Error(r.message || 'External Timer API returned failure status');
              }
            } catch (e: any) {
              sendLog(`\u274C Timer Error: ${e.message}`, 'error');
              break;
            }

            loopCount++;
          }

          // --- HBLINKS ---
          if (currentLink.includes('hblinks')) {
            sendLog('\uD83D\uDD17 Solving HBLinks (Native)...', 'info');
            try {
              const r = await solveHBLinks(currentLink);
              if (r.status === 'success') {
                currentLink = r.link!;
                sendLog('\u2705 HBLinks Solved', 'success');
              } else throw new Error(r.message || 'HBLinks Native Failed');
            } catch (e: any) {
              sendLog(`\u274C HBLinks Error: ${e.message}`, 'error');
              finalResults.set(lid, { ...linkData, status: 'error', error: e.message, logs });
              return;
            }
          }

          // --- HUBDRIVE ---
          if (currentLink.includes('hubdrive')) {
            sendLog('\u2601\uFE0F Solving HubDrive (Native)...', 'info');
            try {
              const r = await solveHubDrive(currentLink);
              if (r.status === 'success') {
                currentLink = r.link!;
                sendLog('\u2705 HubDrive Solved', 'success');
                sendLog('\uD83D\uDD17 Link after HubDrive: ' + currentLink, 'info');
              } else throw new Error(r.message || 'HubDrive Native Failed');
            } catch (e: any) {
              sendLog(`\u274C HubDrive Error: ${e.message}`, 'error');
              finalResults.set(lid, { ...linkData, status: 'error', error: e.message, logs });
              return;
            }
          }

          // =================================================================
          // HUBCLOUD (FINAL) — Uses Python API (cloudscraper) + Native fallback
          // The solveHubCloudNative function handles both layers internally:
          //   Layer 1: External Python API (HUBCLOUD_API_URL env var)
          //   Layer 2: Native axios fallback (non-CF pages only)
          // =================================================================
          let finalFound = false;
          if (currentLink.includes('hubcloud') || currentLink.includes('hubcdn')) {
            sendLog('\u26A1 Getting Direct Link (HubCloud)...', 'info');
            try {
              const r = await solveHubCloudNative(currentLink);

              if (r.status === 'success' && r.best_download_link) {
                const finalLink = r.best_download_link;
                sendLog(`\uD83C\uDF89 COMPLETED via ${r.best_button_name || 'Best Button'}`, 'success');
                send({ id: lid, final: finalLink, status: 'done' });

                // Save the full HubCloud result including all_available_buttons
                finalResults.set(lid, {
                  ...linkData,
                  finalLink: finalLink,
                  status: 'done',
                  logs,
                  // MISSION 3 — TASK C: Store extra HubCloud data for Firestore
                  best_button_name: r.best_button_name || null,
                  all_available_buttons: r.all_available_buttons || [],
                });

                finalFound = true;
                return; // End here on success
              } else {
                throw new Error(r.message || 'HubCloud Native: No download link found');
              }
            } catch (e: any) {
              sendLog(`\u274C HubCloud Error: ${e.message}`, 'error');
            }
          }

          // --- FINAL FALLBACK ---
          if (!finalFound) {
            sendLog('\u274C Unrecognized link format or stuck', 'error');
            send({ id: lid, status: 'error', msg: 'Process ended without final link' });
            finalResults.set(lid, { ...linkData, status: 'error', error: 'Could not solve', logs });
          }
        } catch (e: any) {
          sendLog(`\u26A0\uFE0F Critical Error: ${e.message}`, 'error');
          finalResults.set(lid, { ...linkData, status: 'error', error: e.message, logs });
        } finally {
          send({ id: lid, status: 'finished' });
        }
      };

      // Process all links concurrently
      await Promise.all(links.map((link: any, idx: number) => processLink(link, idx)));

      // ===== PERSIST TO FIREBASE =====
      if (taskId) {
        try {
          const taskRef = db.collection('scraping_tasks').doc(taskId);
          const taskDoc = await taskRef.get();
          if (taskDoc.exists) {
            const taskData = taskDoc.data();
            const existingLinks = taskData?.links || [];

            // Update existing links by matching the original URL
            const updatedLinks = existingLinks.map((existingLink: any, _existingIdx: number) => {
              let matchingResult = null;
              for (const [_key, value] of finalResults.entries()) {
                if (value.link === existingLink.link) {
                  matchingResult = value;
                  break;
                }
              }

              if (matchingResult) {
                // Build the updated link object
                const updatedLink: any = {
                  ...existingLink,
                  finalLink: matchingResult.finalLink || null,
                  status: matchingResult.status || 'error',
                  error: matchingResult.error || null,
                  logs: matchingResult.logs || [],
                };

                // MISSION 3 — TASK C: Save HubCloud-specific data alongside the link
                if (matchingResult.best_button_name) {
                  updatedLink.best_button_name = matchingResult.best_button_name;
                }
                if (matchingResult.all_available_buttons && matchingResult.all_available_buttons.length > 0) {
                  updatedLink.all_available_buttons = matchingResult.all_available_buttons;
                }

                return updatedLink;
              }
              return existingLink; // Keep unchanged (already done or not in this batch)
            });

            // Determine correct task status based on ALL links, not just this batch
            const allDone = updatedLinks.every((l: any) => {
              const s = (l.status || '').toLowerCase();
              return s === 'done' || s === 'success' || s === 'error' || s === 'failed';
            });
            const anyPending = updatedLinks.some((l: any) => {
              const s = (l.status || '').toLowerCase();
              return s === 'pending' || s === 'processing' || s === '';
            });

            let taskStatus = 'processing';
            if (allDone && !anyPending) {
              const anySuccess = updatedLinks.some((l: any) => {
                const s = (l.status || '').toLowerCase();
                return s === 'done' || s === 'success';
              });
              taskStatus = anySuccess ? 'completed' : 'failed';
            }

            await taskRef.update({
              status: taskStatus,
              links: updatedLinks,
              completedAt: allDone ? new Date().toISOString() : null,
            });
          }
        } catch (dbErr: any) {
          console.error('[Stream] Failed to persist to Firebase:', dbErr.message);
        }
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
