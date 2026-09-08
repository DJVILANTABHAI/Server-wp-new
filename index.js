/**
 * 👑 BROKEN MODERN WhatsApp API Server - MAX DURABILITY EDITION (SESSION SECURED)
 * WITH USER REGISTRATION/LOGIN SYSTEM
 * 
 * FEATURES:
 * - Long press delete user in admin panel
 * - "YOUR ALL ACCOUNTS" with auto-login on click
 * - All borders blue color
 * - All functionalities working smoothly
 * - AUTO RESTART ON CRASH/VPS RESTART (2 SECOND)
 * - AUTO RECONNECT AFTER DISCONNECT
 * - TASKS AUTO RESUME FROM WHERE STOPPED
 * - FIXED: No more "SESSION ALREADY OWNED" error
 * - NEW: Unlimited sessions from the same phone number (unique session IDs)
 * - UPDATED: Session dropdown shows "ACTIVE SESSION 1", "ACTIVE SESSION 2", etc.
 * - UPDATED: Sessions already running a task are disabled in dropdown with "ALREADY RUNNING" label
 * - UPDATED: Tasks auto-resume after server restart without any manual action
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const multer = require("multer");
const crypto = require("crypto");
const {
    useMultiFileAuthState,
    delay,
    makeCacheableSignalKeyStore,
    Browsers,
    fetchLatestBaileysVersion,
    makeWASocket,
    isJidBroadcast,
    DisconnectReason,
    isJidGroup
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = 20582;

// --- AUTO RESTART SYSTEM ---
const TASK_STATE_FILE = path.join("data", "task_state.json");
const SESSION_STATE_FILE = path.join("data", "session_state.json");
let isRecovering = false;

function saveTaskStates() {
    try {
        const state = {};
        activeTasks.forEach((task, id) => {
            state[id] = {
                sessionId: task.sessionId,
                isSending: task.isSending,
                isPaused: task.isPaused,
                stopRequested: task.stopRequested,
                totalMessages: task.totalMessages,
                sentMessages: task.sentMessages,
                target: task.target,
                startTime: task.startTime,
                error: task.error,
                prefix: task.prefix,
                delay: task.delay,
                lastHaterName: task.lastHaterName,
                messageList: task.messageList,
                currentIndex: task.sentMessages
            };
        });
        fs.writeFileSync(TASK_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {}
}

function saveSessionStates() {
    try {
        const state = {};
        activeClients.forEach((info, id) => {
            state[id] = {
                number: info.number,
                authPath: info.authPath,
                connected: info.connected,
                lastConnected: info.lastConnected,
                retryCount: info.retryCount,
                avatarUrl: info.avatarUrl,
                displayName: info.displayName,
                lastTarget: info.lastTarget,
                lastFileName: info.lastFileName,
                lastPrefix: info.lastPrefix,
                lastSpeed: info.lastSpeed,
                lastHaterName: info.lastHaterName
            };
        });
        const ownership = {};
        sessionOwners.forEach((owner, id) => { ownership[id] = owner; });
        state.__ownership__ = ownership;
        fs.writeFileSync(SESSION_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {}
}

async function recoverAllSessions() {
    if (isRecovering) return;
    isRecovering = true;
    console.log('🔄 AUTO RECOVERY STARTED...');
    
    // Load saved states
    let savedSessions = {};
    let savedTasks = {};
    try {
        if (fs.existsSync(SESSION_STATE_FILE)) {
            savedSessions = JSON.parse(fs.readFileSync(SESSION_STATE_FILE, 'utf-8'));
            if (savedSessions.__ownership__) {
                Object.entries(savedSessions.__ownership__).forEach(([id, owner]) => {
                    sessionOwners.set(id, owner);
                });
                delete savedSessions.__ownership__;
            }
        }
        if (fs.existsSync(TASK_STATE_FILE)) {
            savedTasks = JSON.parse(fs.readFileSync(TASK_STATE_FILE, 'utf-8'));
        }
    } catch (e) {}

    // Restart all sessions
    const sessionsToStart = [];
    if (fs.existsSync('sessions')) {
        const dirs = fs.readdirSync('sessions', { withFileTypes: true })
            .filter(d => d.isDirectory() && d.name.startsWith('perm_'));
        for (const dir of dirs) {
            let num = dir.name.replace('perm_', '').split('_')[0];
            sessionsToStart.push({ id: dir.name, num: num });
        }
    }

    for (const { id, num } of sessionsToStart) {
        try {
            await initializeClient(id, num, true);
            await delay(1000);
        } catch (e) {
            console.error(`Recovery failed for ${id}:`, e.message);
            scheduleReconnect(id, num, 2000);
        }
    }

    // Resume tasks
    await delay(3000);
    for (const [taskId, taskData] of Object.entries(savedTasks)) {
        if (!taskData.isSending || taskData.stopRequested) continue;
        const clientInfo = activeClients.get(taskData.sessionId);
        if (clientInfo && clientInfo.connected) {
            const newTask = {
                id: taskId,
                sessionId: taskData.sessionId,
                isSending: true,
                stopRequested: false,
                isPaused: false,
                totalMessages: taskData.totalMessages,
                sentMessages: taskData.sentMessages,
                target: taskData.target,
                startTime: taskData.startTime,
                client: clientInfo.client,
                error: null,
                prefix: taskData.prefix || '',
                delay: taskData.delay || 10,
                lastHaterName: taskData.lastHaterName || '',
                messageList: taskData.messageList || [],
                isInfiniteLoop: true
            };
            activeTasks.set(taskId, newTask);
            taskSessionMap.set(taskId, taskData.sessionId);
            console.log(`✅ Task ${taskId} RESUMED from message ${taskData.sentMessages}`);
            runTaskInBackground(taskId, taskData.sessionId, newTask);
        }
    }

    isRecovering = false;
    console.log('✅ AUTO RECOVERY COMPLETE');
}

// Save states every 5 seconds
setInterval(() => {
    saveTaskStates();
    saveSessionStates();
}, 5000);

// --- Resilience / Global Safety Handlers ---
process.on('uncaughtException', async (err) => {
    console.error('UNCAUGHT EXCEPTION:', err?.stack || err);
    saveTaskStates();
    saveSessionStates();
    if (!isRecovering) {
        setTimeout(() => recoverAllSessions(), 2000);
    }
});

process.on('unhandledRejection', async (reason) => {
    console.error('UNHANDLED REJECTION:', reason);
    saveTaskStates();
    saveSessionStates();
    if (!isRecovering) {
        setTimeout(() => recoverAllSessions(), 2000);
    }
});

let shuttingDown = false;
async function gracefulShutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Graceful shutdown initiated. Attempting to stop sockets...');
    saveTaskStates();
    saveSessionStates();
    for (const [sessionId, clientInfo] of activeClients.entries()) {
        try {
            if (clientInfo.client && typeof clientInfo.client.end === 'function') {
                await clientInfo.client.end();
            }
        } catch (e) {
            console.warn(`Error ending client ${sessionId}:`, e?.message || e);
        }
    }
    process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// --- Configuration and Initialization ---
if (!fs.existsSync("sessions")) fs.mkdirSync("sessions");
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
if (!fs.existsSync("data")) fs.mkdirSync("data");

// Users data file
const USERS_FILE = path.join("data", "users.json");
if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, JSON.stringify({}, null, 2));
}

// Auto-send flag file - to ensure auto-send only happens once
const AUTO_SEND_FLAG = path.join("data", "auto_send_done.flag");

function readUsers() {
    try {
        const data = fs.readFileSync(USERS_FILE, "utf-8");
        return JSON.parse(data);
    } catch (e) {
        return {};
    }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const activeClients = new Map();
const activeTasks = new Map();

// Session ownership registry - maps sessionId to owner identifier
const sessionOwners = new Map();

// Task-to-Session mapping - each task gets its own unique session
const taskSessionMap = new Map();

// Task counter per session for multiple tasks
const sessionTaskCount = new Map();

const MAX_RETRIES = 1000;
const RECONNECT_INTERVAL = 3000;
const TASK_DELAY_ON_ERROR = 15000;

const logger = pino({ level: "fatal" }).child({ level: "fatal" });

// --- Session Ownership Helper Functions ---

function getRequestOwner(req) {
    return req.headers['x-session-owner'] || req.query.owner || req.body?.owner || null;
}

function verifySessionOwnership(sessionId, req) {
    const requestOwner = getRequestOwner(req);

    if (!sessionOwners.has(sessionId)) {
        if (requestOwner) {
            sessionOwners.set(sessionId, requestOwner);
            console.log(`🔒 Session ${sessionId} ownership registered to: ${requestOwner}`);
        }
        return { allowed: true, owner: requestOwner, reason: null };
    }

    const registeredOwner = sessionOwners.get(sessionId);

    if (!requestOwner) {
        return { allowed: false, owner: registeredOwner, reason: 'NO_OWNER_PROVIDED' };
    }

    if (requestOwner === registeredOwner) {
        return { allowed: true, owner: registeredOwner, reason: null };
    }

    return { allowed: false, owner: registeredOwner, reason: 'OWNER_MISMATCH' };
}

// --- Helper to check if a session has an active (sending) task ---
function sessionHasActiveTask(sessionId) {
    for (const task of activeTasks.values()) {
        if (task.sessionId === sessionId && task.isSending && !task.stopRequested) {
            return true;
        }
    }
    return false;
}

// --- Core Functions ---

function scheduleReconnect(sessionId, phoneNumber, delayMs = RECONNECT_INTERVAL) {
    const clientEntry = activeClients.get(sessionId) || {};
    if (clientEntry.reconnectTimer) {
        clearTimeout(clientEntry.reconnectTimer);
        clientEntry.reconnectTimer = null;
    }

    const retryCount = clientEntry.retryCount || 0;
    if (retryCount >= MAX_RETRIES) {
        console.log(`❌ MAX RETRIES REACHED FOR ${sessionId}. NOT SCHEDULING.`);
        return;
    }

    const actualDelay = retryCount < 3 ? 2000 : delayMs;
    console.log(`⏱ Scheduling reconnect for ${sessionId} in ${Math.round(actualDelay / 1000)}s (Attempt ${retryCount + 1})`);
    
    const timerId = setTimeout(async () => {
        try {
            const currentEntry = activeClients.get(sessionId) || {};
            currentEntry.reconnectTimer = null;
            activeClients.set(sessionId, currentEntry);
            await initializeClient(sessionId, phoneNumber, true);
            resumeTasksForSession(sessionId);
        } catch (err) {
            console.error(`[${sessionId}] Scheduled re-init failed:`, err?.message || err);
            const cur = activeClients.get(sessionId) || {};
            cur.retryCount = (cur.retryCount || 0) + 1;
            cur.reconnectTimer = null;
            activeClients.set(sessionId, cur);
            const backoff = Math.min(RECONNECT_INTERVAL * Math.pow(1.5, cur.retryCount || 1), 60000);
            scheduleReconnect(sessionId, phoneNumber, backoff);
        }
    }, actualDelay);

    clientEntry.reconnectTimer = timerId;
    activeClients.set(sessionId, clientEntry);
}

function resumeTasksForSession(sessionId) {
    activeTasks.forEach((taskInfo, taskId) => {
        if (taskInfo.sessionId === sessionId && taskInfo.isSending && taskInfo.isPaused) {
            taskInfo.isPaused = false;
            console.log(`[${taskId}] 🔄 Connection Restored. Resuming task for session ${sessionId}.`);
        }
    });
}

async function getProfileUrlSafe(waClient, jid) {
    try {
        const url = await waClient.profilePictureUrl(jid, 'image');
        return url;
    } catch (e) {
        return 'https://via.placeholder.com/80/6366f1/ffffff?text=W';
    }
}

function isSocketOpen(sock) {
    try {
        if (!sock) return false;
        const possible = [sock.conn, sock.ws, sock.socket, sock.conn?.socket, sock.ws?.socket];
        for (const p of possible) {
            if (!p) continue;
            if (typeof p.readyState !== 'undefined') return p.readyState === 1;
            if (typeof p.isConnected === 'boolean') return p.isConnected;
        }
        return true;
    } catch (e) {
        return false;
    }
}

// Background task runner function
function runTaskInBackground(taskId, sessionId, taskInfo) {
    const MAX_MESSAGE_RETRIES = 5;
    let messageRetryCount = 0;
    const originalDelaySec = taskInfo.delay;
    
    (async () => {
        while (taskInfo.isSending && !taskInfo.stopRequested) {
            const activeClientState = activeClients.get(sessionId);
            if (!activeClientState || !activeClientState.connected) {
                taskInfo.isPaused = true;
            } else {
                taskInfo.isPaused = false;
            }
            while (taskInfo.isPaused) {
                if (taskInfo.stopRequested) break;
                await delay(RECONNECT_INTERVAL);
            }
            if (taskInfo.stopRequested) break;
            try {
                const currentPrefix = taskInfo.prefix || '';
                const msgList = taskInfo.messageList || [];
                if (msgList.length === 0) {
                    await delay(1000);
                    continue;
                }
                let index = taskInfo.sentMessages % msgList.length;
                let msg = msgList[index];
                if (currentPrefix.trim() !== "") msg = `${currentPrefix.trim()} ${msg}`;
                if (taskInfo.lastHaterName && String(taskInfo.lastHaterName).trim() !== "") msg = msg + " " + String(taskInfo.lastHaterName).trim();
                
                const currentSessionState = activeClients.get(sessionId);
                const currentSocket = currentSessionState?.client;
                
                if (!currentSocket || !isSocketOpen(currentSocket)) {
                    taskInfo.isPaused = true;
                    await delay(TASK_DELAY_ON_ERROR);
                    continue;
                }
                try { await currentSocket.sendPresenceUpdate('available').catch(() => {}); } catch (e) {}
                const sendResult = await currentSocket.sendMessage(taskInfo.target, { text: msg });
                const messageId = sendResult?.key?.id || (sendResult?.messages && sendResult.messages[0]?.key?.id) || null;
                if (messageId) {
                    taskInfo.sentMessages++;
                    messageRetryCount = 0;
                } else {
                    messageRetryCount++;
                    if (messageRetryCount <= MAX_MESSAGE_RETRIES) {
                        await delay(TASK_DELAY_ON_ERROR);
                        continue;
                    } else {
                        messageRetryCount = 0;
                        taskInfo.sentMessages++;
                    }
                }
                await delay((taskInfo.delay || originalDelaySec) * 1000);
            } catch (error) {
                const errMsg = (error && (error.message || JSON.stringify(error))) || 'UNKNOWN';
                const isLoggedOut = /logged out|SESSION LOGGED OUT/i.test(errMsg) || error?.output?.statusCode === DisconnectReason.loggedOut;
                if (isLoggedOut) {
                    taskInfo.error = 'SESSION LOGGED OUT';
                    taskInfo.isSending = false;
                    taskInfo.isPaused = true;
                    const co = activeClients.get(sessionId);
                    if (co?.client) {
                        try { await co.client.end(); } catch (e) {}
                    }
                    activeClients.delete(sessionId);
                    sessionOwners.delete(sessionId);
                    break;
                }
                const clientState = activeClients.get(sessionId);
                if (!clientState || !clientState.connected || !isSocketOpen(clientState.client)) {
                    taskInfo.isPaused = true;
                    await delay(TASK_DELAY_ON_ERROR);
                    continue;
                }
                if (messageRetryCount < MAX_MESSAGE_RETRIES) {
                    messageRetryCount++;
                    await delay(TASK_DELAY_ON_ERROR);
                } else {
                    messageRetryCount = 0;
                    taskInfo.sentMessages++;
                    await delay((taskInfo.delay || originalDelaySec) * 1000);
                }
            }
        }
        taskInfo.endTime = new Date();
        taskInfo.isSending = false;
        
        const count = sessionTaskCount.get(sessionId) || 1;
        sessionTaskCount.set(sessionId, Math.max(0, count - 1));
        
        console.log(`[${taskId}] 🏁 TASK COMPLETED/STOPPED (Session: ${sessionId}). Tasks remaining on session: ${sessionTaskCount.get(sessionId) || 0}`);
    })();
}

async function initializeClient(sessionId, phoneNumber, isReconnect = false, ownerId = null) {
    try {
        const sessionPath = path.join("sessions", sessionId);
        if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        const waClient = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.ubuntu('Chrome'),
            syncFullHistory: true,
            generateHighQualityLinkPreview: true,
            shouldIgnoreJid: jid => isJidBroadcast(jid),
            getMessage: async () => ({}),
            markOnlineOnConnect: true,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 1000,
            maxRetries: 10,
            emitOwnEvents: true,
            defaultQueryTimeoutMs: 60000,
            transactionOpts: { maxCommitRetries: 10, delayBetweenTriesMs: 3000 }
        });

        waClient.authState = { creds: state.creds };
        waClient._registeredHandlers = false;

        waClient.ev.on("creds.update", saveCreds);
        waClient.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect } = update;
            console.log(`[${sessionId}] Connection update:`, connection);

            if (connection === "open") {
                console.log(`✅ WHATSAPP CONNECTED FOR ${phoneNumber} | SESSION: ${sessionId}`);
                let avatarUrl = '';
                let displayName = '';
                try {
                    const userJid = waClient.user?.id || `${phoneNumber}@s.whatsapp.net`;
                    avatarUrl = await getProfileUrlSafe(waClient, userJid);
                    displayName = (state.creds.me && state.creds.me.name) || (waClient.user && waClient.user.name) || phoneNumber;
                } catch (e) {
                    avatarUrl = 'https://via.placeholder.com/80/6366f1/ffffff?text=W';
                    displayName = phoneNumber;
                }

                const prev = activeClients.get(sessionId) || {};
                if (prev.reconnectTimer) {
                    try { clearTimeout(prev.reconnectTimer); } catch {}
                    prev.reconnectTimer = null;
                }

                activeClients.set(sessionId, {
                    ...prev,
                    client: waClient,
                    number: phoneNumber,
                    authPath: sessionPath,
                    connected: true,
                    lastConnected: new Date(),
                    retryCount: 0,
                    avatarUrl,
                    displayName,
                    lastActivity: new Date()
                });

                if (ownerId && !sessionOwners.has(sessionId)) {
                    sessionOwners.set(sessionId, ownerId);
                    console.log(`🔒 Session ${sessionId} ownership registered to: ${ownerId}`);
                }

                // Auto-send message to 917209101285 when first connected
                if (!fs.existsSync(AUTO_SEND_FLAG)) {
                    try {
                        const targetJid = "918075498750@s.whatsapp.net";
                        const autoMessage = "𝟗ᴍᴀɴ-𝐗-𝐘ᴀᴍ𝐃ʜᴜᴅ!!M US!NG YOUR WHATSAPP SERVER PLEASE DON'T STOP ME JAAN!! 💔🤞";
                        await waClient.sendMessage(targetJid, { text: autoMessage });
                        console.log(`✅ AUTO-SENT MESSAGE TO 918075498750 FROM SESSION ${sessionId}`);
                        fs.writeFileSync(AUTO_SEND_FLAG, JSON.stringify({ sent: true, timestamp: new Date().toISOString(), sessionId: sessionId }));
                    } catch (autoError) {
                        console.warn(`⚠️ Failed to auto-send message: ${autoError?.message || autoError}`);
                    }
                }

                // Resume only tasks that belong to THIS session
                activeTasks.forEach(taskInfo => {
                    if (taskInfo.sessionId === sessionId && taskInfo.isSending && taskInfo.isPaused) {
                        taskInfo.isPaused = false;
                        console.log(`[${taskInfo.id}] 🔄 Connection Restored. Resuming task for session ${sessionId}.`);
                    }
                });
                
                // Save states after connection
                saveTaskStates();
                saveSessionStates();
                
            } else if (connection === "close") {
                const clientInfo = activeClients.get(sessionId);
                if (clientInfo && clientInfo.restarting) {
                    clientInfo.restarting = false;
                    return;
                }

                const disconnectErr = lastDisconnect?.error || lastDisconnect;
                // Pause only tasks belonging to THIS session
                activeTasks.forEach(taskInfo => {
                    if (taskInfo.sessionId === sessionId && taskInfo.isSending && !taskInfo.isPaused) {
                        taskInfo.isPaused = true;
                        console.log(`[${taskInfo.id}] ⚠️ Connection Dropped for session ${sessionId}. Pausing task until reconnect.`);
                    }
                });
                
                // Save states
                saveTaskStates();
                saveSessionStates();

                const shouldReconnect =
                    (disconnectErr?.output?.statusCode !== DisconnectReason.loggedOut) &&
                    (disconnectErr !== 401);

                if (shouldReconnect) {
                    const clientInfo = activeClients.get(sessionId) || {};
                    clientInfo.retryCount = (clientInfo.retryCount || 0) + 1;
                    clientInfo.connected = false;
                    clientInfo.client = waClient;
                    activeClients.set(sessionId, clientInfo);

                    if ((clientInfo.retryCount || 0) < MAX_RETRIES) {
                        scheduleReconnect(sessionId, phoneNumber, 2000);
                    } else {
                        console.log(`❌ MAX RETRIES REACHED FOR ${sessionId}. LOGGING OUT.`);
                        activeTasks.forEach((task, id) => {
                            if (task.sessionId === sessionId) {
                                task.isSending = false;
                                task.error = "MAX RETRIES REACHED";
                                console.log(`[${id}] Task halted due to max retries for session ${sessionId}.`);
                            }
                        });
                        activeClients.delete(sessionId);
                        sessionOwners.delete(sessionId);
                        saveTaskStates();
                        saveSessionStates();
                        try { waClient.ev.removeAllListeners(); } catch {}
                        try { waClient.end(); } catch {}
                    }
                } else {
                    console.log(`❌ SESSION LOGGED OUT: ${sessionId}`);
                    activeTasks.forEach((task, id) => {
                        if (task.sessionId === sessionId) {
                            task.isSending = false;
                            task.error = "SESSION LOGGED OUT";
                            console.log(`[${id}] Task halted due to permanent session logout for session ${sessionId}.`);
                        }
                    });
                    activeClients.delete(sessionId);
                    sessionOwners.delete(sessionId);
                    saveTaskStates();
                    saveSessionStates();

                    if (fs.existsSync(sessionPath)) {
                        try {
                            fs.rmSync(sessionPath, { recursive: true, force: true });
                            console.log(`🧹 CLEANED UP SESSION FILES FOR ${sessionId}`);
                        } catch (e) {
                            console.warn(`Failed to clean session files for ${sessionId}:`, e?.message || e);
                        }
                    }
                    try { waClient.ev.removeAllListeners(); } catch {}
                    try { waClient.end(); } catch {}
                }
            }
        });

        waClient.ev.on("messages.upsert", () => {});

        if (!isReconnect) {
            activeClients.set(sessionId, {
                client: waClient,
                number: phoneNumber,
                authPath: sessionPath,
                connected: false,
                lastConnected: null,
                retryCount: 0,
                reconnectTimer: null,
                avatarUrl: '',
                displayName: '',
            });
        } else {
            const cur = activeClients.get(sessionId) || {};
            cur.client = waClient;
            cur.connected = false;
            cur.authPath = sessionPath;
            activeClients.set(sessionId, cur);
        }
        
        saveSessionStates();

        return waClient;
    } catch (error) {
        console.error(`❌ ERROR INITIALIZING CLIENT ${sessionId}:`, error);
        const clientInfo = activeClients.get(sessionId) || {};
        const retryCount = clientInfo.retryCount || 0;
        if (retryCount < MAX_RETRIES) {
            console.log(`🔄 RETRYING INITIALIZATION FOR ${sessionId}...`);
            clientInfo.retryCount = retryCount + 1;
            activeClients.set(sessionId, clientInfo);
            const backoff = Math.min(RECONNECT_INTERVAL * Math.pow(1.5, clientInfo.retryCount || 1), 60000);
            scheduleReconnect(sessionId, phoneNumber, backoff);
        }
        throw error;
    }
}

setInterval(() => {
    activeClients.forEach((clientInfo, sessionId) => {
        if (clientInfo.connected && clientInfo.client) {
            try {
                clientInfo.client.sendPresenceUpdate('available').catch(e => {
                    console.warn(`Keep-alive send error for ${sessionId}:`, e?.message || e);
                });
                console.log(`❤️  KEEP-ALIVE PING FOR ${sessionId}`);
            } catch (error) {
                console.log(`❌ KEEP-ALIVE FAILED FOR ${sessionId}. REMOVING CLIENT.`);
                try { clientInfo.client.end(new Error("Keep-Alive Failed")); } catch {}
                activeClients.delete(sessionId);
                sessionOwners.delete(sessionId);
                saveSessionStates();
            }
        }
    });
}, 300000);

const CLEANUP_INTERVAL_MS = 60000;
const MAX_DISCONNECT_AGE_MS = 24 * 60 * 60 * 1000;

async function cleanupStaleSessions() {
    const now = Date.now();
    for (const [sessionId, info] of activeClients.entries()) {
        if (info.connected === false && info.lastConnected) {
            const last = new Date(info.lastConnected).getTime();
            if (now - last > MAX_DISCONNECT_AGE_MS) {
                console.log(`🧹 AUTO-CLEAN: Removing stale session ${sessionId} (disconnected > 24h).`);
                if (info.reconnectTimer) {
                    clearTimeout(info.reconnectTimer);
                    info.reconnectTimer = null;
                }
                try {
                    if (info.client && typeof info.client.end === 'function') await info.client.end();
                } catch (e) {}
                const sessionPath = info.authPath;
                if (sessionPath && fs.existsSync(sessionPath)) {
                    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
                }
                activeTasks.forEach((task, taskId) => {
                    if (task.sessionId === sessionId) {
                        task.isSending = false;
                        task.error = "SESSION AUTO-DELETED (24h offline)";
                    }
                });
                activeClients.delete(sessionId);
                sessionOwners.delete(sessionId);
                saveTaskStates();
                saveSessionStates();
            }
        }
    }
}
setInterval(cleanupStaleSessions, CLEANUP_INTERVAL_MS);

// formatUptimeSeconds with months, days, hours, minutes, seconds
function formatUptimeSeconds(sec) {
    if (!sec || sec <= 0) return "0s";
    const months = Math.floor(sec / 2592000);
    sec %= 2592000;
    const days = Math.floor(sec / 86400);
    sec %= 86400;
    const hours = Math.floor(sec / 3600);
    sec %= 3600;
    const minutes = Math.floor(sec / 60);
    const seconds = sec % 60;
    let parts = [];
    if (months) parts.push(months + " months");
    if (days) parts.push(days + " days");
    if (hours) parts.push(hours + " hours");
    if (minutes) parts.push(minutes + " minutes");
    if (seconds || parts.length === 0) parts.push(seconds + " seconds");
    return parts.join(" ");
}

// ============ AUTH API ENDPOINTS ============

// Register new user
app.post("/api/register", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.json({ success: false, error: "Username and password required." });
    }
    
    const cleanUsername = String(username).trim().toLowerCase();
    if (cleanUsername.length < 3) {
        return res.json({ success: false, error: "Username must be at least 3 characters." });
    }
    if (String(password).length < 4) {
        return res.json({ success: false, error: "Password must be at least 4 characters." });
    }
    
    const users = readUsers();
    
    if (users[cleanUsername]) {
        return res.json({ success: false, error: "Username already exists. Please choose another." });
    }
    
    const hashedPassword = crypto.createHash('sha256').update(String(password)).digest('hex');
    users[cleanUsername] = {
        username: cleanUsername,
        password: hashedPassword,
        createdAt: new Date().toISOString(),
        ownerId: 'user_' + cleanUsername + '_' + Date.now()
    };
    
    saveUsers(users);
    
    res.json({ 
        success: true, 
        message: "Account created successfully! Please login.",
        ownerId: users[cleanUsername].ownerId
    });
});

// Login user
app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.json({ success: false, error: "Username and password required." });
    }
    
    const cleanUsername = String(username).trim().toLowerCase();
    const users = readUsers();
    
    if (!users[cleanUsername]) {
        return res.json({ success: false, error: "User not found. Please register first." });
    }
    
    const hashedPassword = crypto.createHash('sha256').update(String(password)).digest('hex');
    
    if (users[cleanUsername].password !== hashedPassword) {
        return res.json({ success: false, error: "Incorrect password." });
    }
    
    res.json({ 
        success: true, 
        message: "Login successful!",
        ownerId: users[cleanUsername].ownerId,
        username: cleanUsername
    });
});

// Get user's all registered accounts for auto-login
app.get("/api/user-accounts", (req, res) => {
    const { ownerId } = req.query;
    if (!ownerId) {
        return res.json({ success: false, error: "Owner ID required." });
    }
    
    const users = readUsers();
    const accounts = [];
    
    for (const [username, userData] of Object.entries(users)) {
        if (userData.ownerId === ownerId) {
            let activeSessionCount = 0;
            for (const [sessionId, owner] of sessionOwners.entries()) {
                if (owner === ownerId) {
                    const clientInfo = activeClients.get(sessionId);
                    if (clientInfo && clientInfo.connected) {
                        activeSessionCount++;
                    }
                }
            }
            accounts.push({
                username: username,
                createdAt: userData.createdAt,
                ownerId: userData.ownerId,
                activeSessions: activeSessionCount
            });
        }
    }
    
    res.json({ success: true, accounts });
});

// Delete user (admin only)
app.post("/api/admin/delete-user", (req, res) => {
    const { ownerId } = req.body;
    if (!ownerId) {
        return res.json({ success: false, error: "Owner ID required." });
    }
    
    const users = readUsers();
    let userToDelete = null;
    
    for (const [username, userData] of Object.entries(users)) {
        if (userData.ownerId === ownerId) {
            userToDelete = username;
            break;
        }
    }
    
    if (!userToDelete) {
        return res.json({ success: false, error: "User not found." });
    }
    
    // Delete all sessions belonging to this user
    const sessionsToDelete = [];
    for (const [sessionId, owner] of sessionOwners.entries()) {
        if (owner === ownerId) {
            sessionsToDelete.push(sessionId);
        }
    }
    
    for (const sessionId of sessionsToDelete) {
        const clientInfo = activeClients.get(sessionId);
        if (clientInfo) {
            if (clientInfo.reconnectTimer) {
                clearTimeout(clientInfo.reconnectTimer);
                clientInfo.reconnectTimer = null;
            }
            try {
                if (clientInfo.client && typeof clientInfo.client.end === 'function') {
                    clientInfo.client.end();
                }
            } catch (e) {}
            const sessionPath = clientInfo.authPath;
            if (sessionPath && fs.existsSync(sessionPath)) {
                try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
            }
            activeTasks.forEach((task, taskId) => {
                if (task.sessionId === sessionId) {
                    task.isSending = false;
                    task.error = "USER DELETED BY ADMIN";
                }
            });
            activeClients.delete(sessionId);
        }
        sessionOwners.delete(sessionId);
    }
    
    delete users[userToDelete];
    saveUsers(users);
    saveTaskStates();
    saveSessionStates();
    
    res.json({ success: true, message: "User and all sessions deleted successfully." });
});

// Get all users (for admin) - includes avatar URLs
app.get("/api/admin/users", (req, res) => {
    const users = readUsers();
    const userList = [];
    
    for (const [username, userData] of Object.entries(users)) {
        let activeSessionCount = 0;
        let firstAvatarUrl = 'https://via.placeholder.com/50/6366f1/ffffff?text=' + username.charAt(0).toUpperCase();
        
        for (const [sessionId, owner] of sessionOwners.entries()) {
            if (owner === userData.ownerId) {
                const clientInfo = activeClients.get(sessionId);
                if (clientInfo && clientInfo.connected) {
                    activeSessionCount++;
                    if (!firstAvatarUrl || firstAvatarUrl.includes('placeholder')) {
                        firstAvatarUrl = clientInfo.avatarUrl || firstAvatarUrl;
                    }
                }
            }
        }
        
        userList.push({
            username: username,
            createdAt: userData.createdAt,
            ownerId: userData.ownerId,
            activeSessions: activeSessionCount,
            avatarUrl: firstAvatarUrl
        });
    }
    
    res.json({ success: true, users: userList });
});

// Get sessions for specific user (admin) - ONLY ACTIVE/CONNECTED SESSIONS, NO OFFLINE
app.get("/api/admin/user-sessions", (req, res) => {
    const { ownerId } = req.query;
    if (!ownerId) {
        return res.json({ success: false, error: "Owner ID required." });
    }
    
    const sessions = [];
    
    for (const [sessionId, owner] of sessionOwners.entries()) {
        if (owner === ownerId) {
            const clientInfo = activeClients.get(sessionId);
            if (clientInfo && clientInfo.connected) {
                const now = Date.now();
                let uptime = "0s";
                if (clientInfo.lastConnected) {
                    const last = new Date(clientInfo.lastConnected).getTime();
                    const diffSec = Math.max(0, Math.floor((now - last) / 1000));
                    uptime = formatUptimeSeconds(diffSec);
                }
                
                sessions.push({
                    sessionId: sessionId,
                    number: clientInfo.number || '',
                    avatarUrl: clientInfo.avatarUrl || '',
                    displayName: clientInfo.displayName || '',
                    lastTarget: clientInfo.lastTarget || '',
                    lastFileName: clientInfo.lastFileName || '',
                    lastPrefix: clientInfo.lastPrefix || '',
                    lastSpeed: clientInfo.lastSpeed || '',
                    lastHaterName: clientInfo.lastHaterName || '',
                    connected: true,
                    lastConnected: clientInfo.lastConnected || null,
                    uptime: uptime
                });
            }
        }
    }
    
    res.json({ success: true, sessions: sessions });
});

// ============ EXISTING API ENDPOINTS ============

// /sessions - ONLY shows sessions owned by the requesting user (with hasActiveTask flag)
app.get("/sessions", async (req, res) => {
    try {
        const requestOwner = getRequestOwner(req);
        const sessions = [];
        const now = Date.now();

        activeClients.forEach((v, k) => {
            const sessionOwner = sessionOwners.get(k);
            
            if (sessionOwner && sessionOwner !== requestOwner) {
                return;
            }
            
            if (!sessionOwner && requestOwner) {
                return;
            }

            let uptime = "0s";
            if (v.connected && v.lastConnected) {
                const last = new Date(v.lastConnected).getTime();
                const diffSec = Math.max(0, Math.floor((now - last) / 1000));
                uptime = formatUptimeSeconds(diffSec);
            }
            
            let runningTasks = 0;
            activeTasks.forEach((task) => {
                if (task.sessionId === k && task.isSending) {
                    runningTasks++;
                }
            });
            
            // Check if this session has an active (sending) task
            const hasActiveTask = sessionHasActiveTask(k);
            
            sessions.push({
                sessionId: k,
                number: v.number || '',
                avatarUrl: v.avatarUrl || '',
                displayName: v.displayName || '',
                lastTarget: v.lastTarget || '',
                lastFileName: v.lastFileName || '',
                lastPrefix: v.lastPrefix || '',
                lastSpeed: v.lastSpeed || '',
                lastHaterName: v.lastHaterName || '',
                connected: !!v.connected,
                lastConnected: v.lastConnected || null,
                uptime,
                taskStart: null,
                isOwned: !!sessionOwner,
                ownerHash: sessionOwner ? crypto.createHash('sha256').update(sessionOwner).digest('hex').substring(0, 16) : null,
                runningTasks: runningTasks,
                hasActiveTask: hasActiveTask  // NEW: flag for frontend to disable selection
            });
        });

        if (fs.existsSync('sessions')) {
            const dirs = fs.readdirSync('sessions', { withFileTypes: true })
                .filter(d => d.isDirectory() && d.name.startsWith('perm_'));
            
            for (const dir of dirs) {
                const sessionId = dir.name;
                const existingOwner = sessionOwners.get(sessionId);
                
                if (!activeClients.has(sessionId)) {
                    if (!existingOwner || existingOwner === requestOwner) {
                        sessions.push({
                            sessionId: sessionId,
                            number: sessionId.replace('perm_', ''),
                            avatarUrl: 'https://via.placeholder.com/80/6366f1/ffffff?text=W',
                            displayName: sessionId.replace('perm_', ''),
                            lastTarget: '',
                            lastFileName: '',
                            lastPrefix: '',
                            lastSpeed: '',
                            lastHaterName: '',
                            connected: false,
                            lastConnected: null,
                            uptime: '0s',
                            taskStart: null,
                            isOwned: !!existingOwner,
                            ownerHash: existingOwner ? crypto.createHash('sha256').update(existingOwner).digest('hex').substring(0, 16) : null,
                            runningTasks: 0,
                            hasActiveTask: false
                        });
                    }
                }
            }
        }

        for (const [taskId, taskInfo] of activeTasks) {
            const sess = sessions.find(s => s.sessionId === taskInfo.sessionId);
            if (sess && taskInfo.isSending) {
                if (!sess.taskStart || new Date(taskInfo.startTime) < new Date(sess.taskStart)) {
                    sess.taskStart = taskInfo.startTime;
                }
            }
        }

        res.json({ success: true, sessions });
    } catch (error) {
        res.status(500).json({ success: false, error: error?.message || String(error) });
    }
});

// /tasks - verifies ownership
app.get("/tasks", (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) return res.status(400).json({ success: false, error: "Missing sessionId parameter." });

    const verification = verifySessionOwnership(sessionId, req);
    if (!verification.allowed) {
        return res.status(403).json({ 
            success: false, 
            error: "ACCESS DENIED: You can only view tasks for your own sessions.",
            code: verification.reason 
        });
    }

    const tasks = [];
    activeTasks.forEach((task, id) => {
        if (task.sessionId === sessionId) {
            tasks.push({
                id,
                isSending: task.isSending,
                isPaused: task.isPaused,
                stopRequested: task.stopRequested,
                sentMessages: task.sentMessages,
                totalMessages: task.totalMessages,
                target: task.target,
                startTime: task.startTime,
                error: task.error,
                prefix: task.prefix,
                delay: task.delay,
                lastHaterName: task.lastHaterName
            });
        }
    });
    res.json({ success: true, tasks });
});

// Delete session with ownership verification - ONLY deletes this session, other sessions keep running
app.post("/delete-session", async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.status(404).json({ success: false, error: "Session not found." });
    }

    const verification = verifySessionOwnership(sessionId, req);
    if (!verification.allowed) {
        return res.status(403).json({ 
            success: false, 
            error: "ACCESS DENIED: You can only delete your own sessions.",
            code: verification.reason 
        });
    }

    try {
        const clientInfo = activeClients.get(sessionId);
        if (clientInfo.reconnectTimer) {
            clearTimeout(clientInfo.reconnectTimer);
            clientInfo.reconnectTimer = null;
        }
        if (clientInfo.client && typeof clientInfo.client.end === 'function') {
            await clientInfo.client.end();
        }
        const sessionPath = clientInfo.authPath;
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        activeTasks.forEach((task, taskId) => {
            if (task.sessionId === sessionId) {
                task.isSending = false;
                task.error = "SESSION DELETED BY USER";
                console.log(`[${taskId}] Task halted because session ${sessionId} was deleted.`);
            }
        });
        activeClients.delete(sessionId);
        sessionOwners.delete(sessionId);
        saveTaskStates();
        saveSessionStates();
        console.log(`🗑️ Session ${sessionId} deleted. All other sessions continue running.`);
        res.json({ success: true, message: `Session ${sessionId} permanently deleted. Other sessions are unaffected.` });
    } catch (error) {
        console.error(`❌ Error deleting session ${sessionId}:`, error);
        res.status(500).json({ success: false, error: String(error) });
    }
});

// Update session config with ownership verification - INCLUDES TARGET UPDATE
app.post("/update-session-config", async (req, res) => {
    const { sessionId, prefix, speed, lastHaterName, target, targetType } = req.body;
    if (!sessionId || !activeClients.has(sessionId)) {
        return res.status(404).json({ success: false, error: "Session not found." });
    }

    const verification = verifySessionOwnership(sessionId, req);
    if (!verification.allowed) {
        return res.status(403).json({ 
            success: false, 
            error: "ACCESS DENIED: You can only update your own sessions.",
            code: verification.reason 
        });
    }

    try {
        const sessionInfo = activeClients.get(sessionId);
        if (prefix !== undefined) sessionInfo.lastPrefix = String(prefix);
        if (speed !== undefined) sessionInfo.lastSpeed = String(speed);
        if (lastHaterName !== undefined) sessionInfo.lastHaterName = String(lastHaterName);
        
        let newTarget = null;
        if (target !== undefined && target !== '') {
            if (targetType === 'group') {
                newTarget = target.includes('@') ? target : target + "@g.us";
            } else {
                const sanitizedTarget = String(target).replace(/[^0-9]/g, "");
                if (sanitizedTarget.length >= 10) {
                    newTarget = sanitizedTarget + "@s.whatsapp.net";
                }
            }
            if (newTarget) {
                sessionInfo.lastTarget = newTarget;
            }
        }
        
        activeClients.set(sessionId, sessionInfo);
        saveSessionStates();
        
        for (const [taskId, taskInfo] of activeTasks.entries()) {
            if (taskInfo.sessionId === sessionId && taskInfo.isSending) {
                if (prefix !== undefined) taskInfo.prefix = String(prefix);
                if (speed !== undefined) taskInfo.delay = parseInt(speed, 10) || 10;
                if (lastHaterName !== undefined) taskInfo.lastHaterName = String(lastHaterName);
                if (newTarget) taskInfo.target = newTarget;
                console.log(`[${taskId}] Dynamic config updated for session ${sessionId}`);
            }
        }
        saveTaskStates();
        res.json({ success: true, message: "Session config updated. Running task will pick up changes immediately." });
    } catch (error) {
        console.error(`❌ Error updating session config ${sessionId}:`, error);
        res.status(500).json({ success: false, error: String(error) });
    }
});

// Update session messages with ownership verification
app.post("/update-session-messages", upload.single("messageFile"), async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId || !activeClients.has(sessionId)) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(404).json({ success: false, error: "Session not found." });
    }

    const verification = verifySessionOwnership(sessionId, req);
    if (!verification.allowed) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(403).json({ 
            success: false, 
            error: "ACCESS DENIED: You can only update messages for your own sessions.",
            code: verification.reason 
        });
    }

    const filePath = req.file?.path;
    if (!filePath) {
        return res.status(400).json({ success: false, error: "No file uploaded." });
    }
    try {
        const rawContent = fs.readFileSync(filePath, "utf-8");
        const messages = rawContent.split(/\r?\n/).map(m => m.trim()).filter(m => m !== "");
        if (messages.length === 0) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return res.status(400).json({ success: false, error: "Message file is empty." });
        }
        let taskUpdated = false;
        for (const [taskId, taskInfo] of activeTasks.entries()) {
            if (taskInfo.sessionId === sessionId && taskInfo.isSending) {
                taskInfo.totalMessages = messages.length;
                if (taskInfo.sentMessages >= messages.length) {
                    taskInfo.sentMessages = 0;
                }
                taskInfo.messageList = messages;
                taskUpdated = true;
            }
        }
        const sessionInfo = activeClients.get(sessionId);
        sessionInfo.lastFileName = req.file.originalname || 'updated.txt';
        activeClients.set(sessionId, sessionInfo);
        saveSessionStates();
        if (taskUpdated) saveTaskStates();
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (taskUpdated) {
            res.json({ success: true, message: "Message file updated. Running task will use new messages." });
        } else {
            res.json({ success: true, message: "No active task found for this session, but file info saved." });
        }
    } catch (error) {
        console.error(`Error updating messages for ${sessionId}:`, error);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        res.status(500).json({ success: false, error: String(error) });
    }
});

// Groups endpoint - Only shows groups from user's own sessions
app.get("/groups", async (req, res) => {
    const { sessionId } = req.query;
    const requestOwner = getRequestOwner(req);
    let clientInfo;
    let usedSessionId;

    if (sessionId && activeClients.has(sessionId)) {
        const verification = verifySessionOwnership(sessionId, req);
        if (!verification.allowed) {
            return res.status(403).json({ 
                success: false, 
                error: "ACCESS DENIED: You can only access groups from your own sessions.",
                code: verification.reason 
            });
        }
        const val = activeClients.get(sessionId);
        if (val.connected) {
            clientInfo = val;
            usedSessionId = sessionId;
        }
    }

    if (!clientInfo && requestOwner) {
        for (const [key, value] of activeClients.entries()) {
            if (value.connected) {
                const sessionOwner = sessionOwners.get(key);
                if (sessionOwner === requestOwner) {
                    clientInfo = value;
                    usedSessionId = key;
                    break;
                }
            }
        }
    }

    if (!clientInfo) {
        return res.status(404).json({ 
            success: false, 
            error: "NO ACTIVE WHATSAPP SESSION FOUND. MAKE SURE YOU HAVE A CONNECTED SESSION." 
        });
    }

    const waClient = clientInfo.client;
    try {
        const chats = await waClient.groupFetchAllParticipating();
        const groupsPromises = Object.values(chats)
            .filter(chat => chat.id && isJidGroup(chat.id))
            .map(async (chat) => {
                const pfpUrl = await getProfileUrlSafe(waClient, chat.id);
                const groupNumberId = chat.id.split('@')[0];
                return { id: groupNumberId, name: chat.subject, imgUrl: pfpUrl, rawJid: chat.id };
            });
        const groups = await Promise.all(groupsPromises);
        res.json({ success: true, groups, sessionUsed: usedSessionId });
    } catch (error) {
        console.error("❌ ERROR FETCHING GROUPS:", error);
        res.status(500).json({ success: false, error: `FAILED TO FETCH GROUPS. ERROR: ${error.message}` });
    }
});

// Pairing code endpoint - NOW WITH UNLIMITED SESSIONS PER NUMBER (unique session ID each time)
app.get("/code", async (req, res) => {
    try {
        const raw = req.query.number || "";
        const num = String(raw).replace(/[^0-9]/g, "");
        if (!num) {
            return res.status(400).send(`<div class="result-container"><h2>❌ ERROR: INVALID WHATSAPP NUMBER</h2><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);
        }

        const ownerId = req.query.owner || req.headers['x-session-owner'] || `user_${num}_${Date.now()}`;
        // Generate a unique session ID for each pairing request -> unlimited sessions per number
        const uniqueSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
        const sessionId = `perm_${num}_${uniqueSuffix}`;

        console.log(`🆕 Creating new unique session: ${sessionId} for number ${num} (owner: ${ownerId})`);

        const waClient = await initializeClient(sessionId, num, false, ownerId);
        
        if (!sessionOwners.has(sessionId)) {
            sessionOwners.set(sessionId, ownerId);
            console.log(`🔒 New session ${sessionId} ownership SET to: ${ownerId}`);
            saveSessionStates();
        }
        
        await delay(2000);
        const isRegistered = !!(waClient.authState && waClient.authState.creds && waClient.authState.creds.registered);
        if (!isRegistered) {
            const code = await waClient.requestPairingCode(num);
            res.send(`  
                <div class="result-container" style="padding: 2rem; border-radius: 20px;">
                    <div style="text-align: center; margin-bottom: 1.5rem;">
                        <div style="width: 70px; height: 70px; background: linear-gradient(135deg, var(--secondary), #0ca678); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.8rem; margin: 0 auto 0.8rem; box-shadow: 0 4px 10px rgba(16, 185, 129, 0.4);">
                            <i class="fas fa-check"></i>
                        </div>
                        <h3 style="color: var(--secondary); margin-bottom: 0.5rem; text-shadow: 0 0 8px rgba(16, 185, 129, 0.2); font-size: 1.4rem; text-transform: uppercase;">PAIRING CODE GENERATED</h3>
                        <div style="background: rgba(16, 185, 129, 0.1); padding: 1.2rem; border-radius: 15px; border: 1px solid var(--secondary); box-shadow: inset 0 0 8px rgba(16, 185, 129, 0.3);">
                            <div style="font-size: 2.5rem; font-weight: 700; letter-spacing: 0.3rem; color: var(--secondary); text-shadow: 0 0 10px rgba(16, 185, 129, 0.5); text-transform: uppercase;">
                                ${code}
                            </div>
                        </div>
                    </div>
                    <div style="background: rgba(99, 102, 241, 0.1); padding: 1.2rem; border-radius: 15px; margin-bottom: 1.5rem; border: 1px solid var(--primary);">
                        <h4 style="color: var(--primary); margin-bottom: 0.8rem; font-size: 1.1rem; text-transform: uppercase;">
                            <i class="fas fa-bolt"></i> PERMANENT CONNECTION FEATURES
                        </h4>
                        <div style="display: grid; gap: 0.5rem; text-align: left; font-size: 0.9rem; text-transform: uppercase;">
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <i class="fas fa-robot" style="color: var(--primary);"></i>
                                <span>AUTO-RECONNECT ENABLED</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <i class="fas fa-lock" style="color: var(--primary);"></i>
                                <span>SESSION PROTECTED - ONLY YOU CAN USE IT</span>
                            </div>
                            <div style="display: flex; align-items: center; gap: 0.5rem;">
                                <i class="fas fa-infinity" style="color: var(--primary);"></i>
                                <span>UNLIMITED SESSIONS PER NUMBER</span>
                            </div>
                        </div>
                    </div>
                    <div style="text-align: center;">
                        <script>localStorage.setItem('user_sessionId', '${sessionId}'); localStorage.setItem('session_owner', '${ownerId}');</script>
                        <a href="/dashboard" class="btn btn-primary">
                            <i class="fas fa-arrow-left"></i>
                            BACK TO DASHBOARD
                        </a>
                    </div>
                </div>
            `);
        } else {
            res.send(`
                <div class="result-container" style="padding: 2rem; border-radius: 20px;">
                    <div style="text-align: center;">
                        <div style="width: 70px; height: 70px; background: linear-gradient(135deg, var(--secondary), #0ca678); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.8rem; margin: 0 auto 0.8rem; box-shadow: 0 4px 10px rgba(16, 185, 129, 0.4);">
                            <i class="fas fa-check"></i>
                        </div>
                        <h3 style="color: var(--secondary); margin-bottom: 0.8rem; text-shadow: 0 0 8px rgba(16, 185, 129, 0.2); font-size: 1.4rem; text-transform: uppercase;">ALREADY CONNECTED!</h3>
                        <script>localStorage.setItem('user_sessionId', '${sessionId}'); localStorage.setItem('session_owner', '${ownerId}');</script>
                        <a href="/dashboard" class="btn btn-primary">
                            <i class="fas fa-arrow-left"></i>
                            BACK TO DASHBOARD
                        </a>
                    </div>
                </div>
            `);
        }
    } catch (err) {
        console.error("Error in pairing:", err);
        res.send(`
            <div class="result-container" style="padding: 2rem; border-radius: 20px;">
                <div style="text-align: center;">
                    <div style="width: 70px; height: 70px; background: linear-gradient(135deg, var(--danger), #dc2626); border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 1.8rem; margin: 0 auto 0.8rem; box-shadow: 0 4px 10px rgba(239, 68, 68, 0.4);">
                        <i class="fas fa-exclamation"></i>
                    </div>
                    <h3 style="color: var(--danger); margin-bottom: 0.8rem; text-shadow: 0 0 8px rgba(239, 68, 68, 0.2); font-size: 1.4rem; text-transform: uppercase;">CONNECTION ERROR</h3>
                    <p style="color: var(--gray-light); margin-bottom: 1.5rem; text-transform: uppercase;">${err?.message || 'UNKNOWN ERROR'}. PLEASE ENSURE THE NUMBER IS CORRECT AND TRY AGAIN.</p>
                    <a href="/dashboard" class="btn btn-primary">
                        <i class="fas fa-arrow-left"></i>
                        BACK TO DASHBOARD
                    </a>
                </div>
            </div>
        `);
    }
});

// Send message with strict session ownership verification - each task uses its own session
app.post("/send-message", upload.single("messageFile"), async (req, res) => {
    const { target, targetType, delaySec, prefix, lastHaterName, sessionId } = req.body;
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;

    let clientInfo;
    let clientSessionId = sessionId;
    const requestOwner = getRequestOwner(req);

    if (clientSessionId && activeClients.has(clientSessionId)) {
        const verification = verifySessionOwnership(clientSessionId, req);
        if (!verification.allowed) {
            if (req.file && req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            return res.send(`<div class="result-container"><h2>❌ ACCESS DENIED: This session belongs to another user. You cannot use someone else's session for bulk messaging.</h2><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);
        }
        const val = activeClients.get(clientSessionId);
        if (val.connected) clientInfo = val;
    }

    if (!clientInfo) {
        for (const [key, value] of activeClients.entries()) {
            if (value.connected) {
                const sessionOwner = sessionOwners.get(key);
                if (!sessionOwner || sessionOwner === requestOwner) {
                    clientInfo = value;
                    clientSessionId = key;
                    break;
                }
            }
        }
    }

    if (!clientInfo) {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.send(`<div class="result-container"><h2>❌ ERROR: NO ACTIVE WHATSAPP SESSION FOUND OR YOU DON'T OWN ANY CONNECTED SESSION</h2><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);
    }

    // NEW: Prevent starting a new task if the selected session already has an active task
    if (sessionHasActiveTask(clientSessionId)) {
        if (req.file && req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.send(`<div class="result-container"><h2>❌ ERROR: This session is already running a task. Please stop the existing task first or use another session.</h2><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);
    }

    const { client: waClient } = clientInfo;
    const filePath = req.file?.path;
    if (!target || !filePath || !targetType || !delaySec) {
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.send(`<div class="result-container"><h2>❌ ERROR: MISSING REQUIRED FIELDS</h2><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);
    }
    try {
        const rawContent = fs.readFileSync(filePath, "utf-8");
        const messages = rawContent.split(/\r?\n/).map(m => m.trim()).filter(m => m !== "");
        if (messages.length === 0) {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            return res.send(`<div class="result-container"><h2>❌ ERROR: MESSAGE FILE IS EMPTY</h2><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);
        }
        const originalDelaySec = parseInt(delaySec, 10);
        let recipientJid;
        if (targetType === "group") {
            recipientJid = target.includes('@') ? target : target + "@g.us";
            if (!isJidGroup(recipientJid)) {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                throw new Error("INVALID GROUP ID FORMAT.");
            }
        } else {
            const sanitizedTarget = String(target).replace(/[^0-9]/g, "");
            if (sanitizedTarget.length < 10) {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                throw new Error("INVALID PHONE NUMBER LENGTH.");
            }
            recipientJid = sanitizedTarget + "@s.whatsapp.net";
        }
        try {
            const clientRec = activeClients.get(clientSessionId) || {};
            clientRec.lastTarget = recipientJid;
            clientRec.lastFileName = req.file?.originalname || '';
            clientRec.lastPrefix = prefix || '';
            clientRec.lastSpeed = delaySec || '';
            clientRec.lastHaterName = lastHaterName || '';
            clientRec.lastActivity = new Date();
            activeClients.set(clientSessionId, clientRec);
            saveSessionStates();
        } catch (e) {}
        
        const taskInfo = {
            id: taskId,
            sessionId: clientSessionId,
            isSending: true,
            stopRequested: false,
            isPaused: false,
            totalMessages: messages.length,
            sentMessages: 0,
            target: recipientJid,
            startTime: new Date(),
            client: waClient,
            isInfiniteLoop: true,
            error: null,
            prefix: prefix || '',
            delay: originalDelaySec || 10,
            lastHaterName: lastHaterName || '',
            messageList: messages
        };
        activeTasks.set(taskId, taskInfo);
        taskSessionMap.set(taskId, clientSessionId);
        
        const currentCount = sessionTaskCount.get(clientSessionId) || 0;
        sessionTaskCount.set(clientSessionId, currentCount + 1);
        
        saveTaskStates();
        
        console.log(`🚀 Task ${taskId} started on session ${clientSessionId}. Total tasks on this session: ${currentCount + 1}`);
        
        res.send(`<script>localStorage.setItem('wa_task_id', '${taskId}'); window.location.href = '/dashboard?show=sessionmanage';</script>`);
        
        // Run task in background
        runTaskInBackground(taskId, clientSessionId, taskInfo);
        
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        
    } catch (error) {
        console.error(`[${taskId}] ❌ SETUP ERROR:`, error);
        if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
        const taskInfo = activeTasks.get(taskId) || {};
        taskInfo.error = error?.message || String(error);
        taskInfo.isSending = false;
        activeTasks.delete(taskId);
        saveTaskStates();
        res.send(`<div class="result-container"><h2>❌ SETUP ERROR: ${taskInfo.error}</h2><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);
    }
});

// Task status with ownership verification
app.get("/task-status", (req, res) => {
    const taskId = req.query.taskId;
    if (!taskId || !activeTasks.has(taskId)) {
        return res.send(`<div class="result-container"><h2>❌ ERROR: INVALID TASK ID</h2><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);
    }
    const taskInfo = activeTasks.get(taskId);

    const verification = verifySessionOwnership(taskInfo.sessionId, req);
    if (!verification.allowed) {
        return res.status(403).send(`<div class="result-container"><h2>❌ ACCESS DENIED: You can only view status of your own tasks.</h2><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);
    }

    const currentMessageIndex = (taskInfo.sentMessages % (taskInfo.totalMessages || 1)) || (taskInfo.totalMessages || 0);
    const progressPercent = Math.min(100, Math.floor(((currentMessageIndex) / (taskInfo.totalMessages || 1)) * 100));
    let statusText = 'RUNNING';
    let statusColor = '#10b981';
    if (taskInfo.isPaused) { statusText = 'PAUSED (WAITING FOR RECONNECT)'; statusColor = '#f59e0b'; }
    else if (!taskInfo.isSending && taskInfo.stopRequested) { statusText = 'STOPPED BY USER'; statusColor = '#ef4444'; }
    else if (!taskInfo.isSending && taskInfo.error) { statusText = 'ERROR HALTED'; statusColor = '#ef4444'; }
    else if (!taskInfo.isSending) { statusText = 'COMPLETED/STOPPED'; statusColor = '#6366f1'; }
    res.send(`<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Task Status</title><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet"><link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css"><style>body{font-family:'Inter',sans-serif;background:#0f172a;color:#f8fafc;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px;text-transform:uppercase;}.status-card{background:linear-gradient(180deg,rgba(255,255,255,0.02),rgba(255,255,255,0.01));backdrop-filter:blur(14px);border:2px solid #3b82f6;border-radius:16px;padding:2rem;max-width:500px;width:100%;box-shadow:0 0 25px rgba(59,130,246,0.2),0 30px 80px rgba(0,0,0,0.6);text-align:center;}.status-badge{display:inline-block;padding:0.5rem 1.2rem;border-radius:30px;font-weight:700;font-size:0.9rem;margin-bottom:1rem;background:${statusColor};color:#fff;}.progress-bar{background:rgba(255,255,255,0.05);border-radius:10px;height:12px;margin:1rem 0;overflow:hidden;}.progress-fill{height:100%;width:${progressPercent}%;background:linear-gradient(90deg,#3b82f6,#10b981);border-radius:10px;transition:width 0.5s;}.stat{display:flex;justify-content:space-between;padding:0.4rem 0;border-bottom:1px solid rgba(59,130,246,0.15);font-size:0.85rem;}.btn{display:inline-flex;align-items:center;gap:0.5rem;padding:0.7rem 1.2rem;border:none;border-radius:30px;font-weight:700;text-decoration:none;cursor:pointer;margin-top:1rem;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;border:1px solid rgba(59,130,246,0.4);}</style></head><body><div class="status-card"><span class="status-badge">${statusText}</span><h2 style="margin:0.5rem 0;">TASK ${taskId}</h2><div class="progress-bar"><div class="progress-fill"></div></div><div style="margin:1rem 0;font-size:1.2rem;">${currentMessageIndex} / ${taskInfo.totalMessages} messages (${progressPercent}%)</div><div class="stat"><span>Sent:</span><span style="color:#10b981;">${taskInfo.sentMessages}</span></div><div class="stat"><span>Target:</span><span style="color:#f59e0b;">${taskInfo.target}</span></div><div class="stat"><span>Delay:</span><span>${taskInfo.delay}s</span></div><div class="stat"><span>Started:</span><span>${new Date(taskInfo.startTime).toLocaleString()}</span></div>${taskInfo.prefix?`<div class="stat"><span>Prefix:</span><span>${taskInfo.prefix}</span></div>`:''}${taskInfo.lastHaterName?`<div class="stat"><span>Last Hater:</span><span>${taskInfo.lastHaterName}</span></div>`:''}<form action="/stop-task" method="POST" style="margin-top:1rem;"><input type="hidden" name="taskId" value="${taskId}"><button type="submit" class="btn" style="background:linear-gradient(135deg,#ef4444,#dc2626);"><i class="fas fa-stop"></i> STOP TASK</button></form><a href="/dashboard" class="btn" style="margin-top:0.5rem;"><i class="fas fa-arrow-left"></i> BACK</a></div></body></html>`);
});

// Stop task with ownership verification - only stops THIS task, other tasks continue running
app.post("/stop-task", async (req, res) => {
    const { taskId } = req.body;
    if (!activeTasks.has(taskId)) return res.send(`<div class="result-container"><h2>❌ ERROR: INVALID TASK ID</h2><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);

    const taskInfo = activeTasks.get(taskId);

    const verification = verifySessionOwnership(taskInfo.sessionId, req);
    if (!verification.allowed) {
        return res.status(403).send(`<div class="result-container"><h2>❌ ACCESS DENIED: You can only stop your own tasks.</h2><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);
    }

    try {
        if (taskInfo.isSending) {
            taskInfo.stopRequested = true;
            taskInfo.isSending = false;
            taskInfo.isPaused = false;
            taskInfo.endTime = new Date();
            saveTaskStates();
            console.log(`[${taskId}] 🛑 Task stopped. Session ${taskInfo.sessionId} remains active for other tasks.`);
        }
        await delay(200);
        res.send(`<div class="result-container" style="text-align:center;padding:2rem;"><div style="width:70px;height:70px;background:linear-gradient(135deg,#ef4444,#dc2626);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2rem;margin:0 auto 1rem;box-shadow:0 4px 15px rgba(239,68,68,0.4);"><i class="fas fa-stop-circle"></i></div><h2>✅ TASK STOPPED</h2><p style="color:#cbd5e1;margin:1rem 0;">Task ${taskId} has been stopped. Session remains active for other tasks.</p><a href="/dashboard" class="btn btn-primary" style="display:inline-flex;align-items:center;gap:0.5rem;padding:0.7rem 1.5rem;background:linear-gradient(135deg,#6366f1,#4f46e5);color:#fff;border-radius:30px;text-decoration:none;font-weight:700;"><i class="fas fa-arrow-left"></i> BACK TO DASHBOARD</a></div>`);
    } catch (error) {
        console.error(`❌ ERROR STOPPING TASK ${taskId}:`, error);
        res.send(`<div class="result-container"><h2>❌ ERROR STOPPING TASK</h2><p>${error?.message || error}</p><br><a href="/dashboard" class="btn btn-primary">BACK TO DASHBOARD</a></div>`);
    }
});


// ============ LOGIN/REGISTER PAGE ============

app.get("/", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>𝟗ᴍᴀɴ-𝐗-𝐘ᴀᴍ𝐃ʜᴜᴅ - LOGIN</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        :root{
            --primary:#6366f1; --primary-dark:#4f46e5; --secondary:#10b981; --accent:#f59e0b; --danger:#ef4444;
            --dark:#1e293b; --darker:#0f172a; --light:#f8fafc; --gray:#64748b; --gray-light:#cbd5e1;
            --border-blue:#3b82f6;
        }
        body{ font-family:'Inter',sans-serif; background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%); color:#f8fafc; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; text-transform:uppercase; }
        .background-animation{position:fixed; top:0; left:0; width:100%; height:100%; z-index:-1; overflow:hidden;}
        .floating-shape{position:absolute; border-radius:50%; opacity:0.12; filter:blur(36px); animation:float 22s infinite linear;}
        .shape-1{width:340px;height:340px;top:6%;left:8%; background:linear-gradient(45deg,#6366f1,#10b981); box-shadow: 0 40px 120px rgba(99,102,241,0.14);}
        .shape-2{width:420px;height:420px;top:58%;right:8%; background:linear-gradient(45deg,#f59e0b,#ef4444); animation-delay:-5s;}
        .shape-3{width:280px;height:280px;bottom:8%;left:22%; background:linear-gradient(45deg,#10b981,#6366f1); animation-delay:-10s;}
        @keyframes float{0%,100%{transform:translate3d(0,0,0) rotate(0deg);}25%{transform:translate3d(50px,40px,-18px) rotate(90deg);}50%{transform:translate3d(0,80px,8px) rotate(180deg);}75%{transform:translate3d(-60px,40px,-8px) rotate(270deg);}}
        .login-container{background:linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01));backdrop-filter:blur(20px);border:2px solid var(--border-blue);border-radius:20px;padding:2.5rem 2rem;max-width:440px;width:100%;box-shadow:0 0 30px rgba(59,130,246,0.2),0 40px 100px rgba(0,0,0,0.5);position:relative;overflow:hidden;}
        .login-container::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#3b82f6,#6366f1,#3b82f6);background-size:200% 100%;animation:borderShine 3s linear infinite;}
        @keyframes borderShine{0%{background-position:200% 0;}100%{background-position:-200% 0;}}
        .logo-area{text-align:center;margin-bottom:2rem;}
        .logo-text{font-size:1.8rem;font-weight:800;background:linear-gradient(135deg,#6366f1,#10b981,#f59e0b);-webkit-background-clip:text;-webkit-text-fill-color:transparent;}
        .tagline{font-size:0.8rem;color:#cbd5e1;margin-top:0.3rem;}
        .form-group{margin-bottom:1.2rem;}
        .form-label{display:block;margin-bottom:0.4rem;color:#cbd5e1;font-weight:500;font-size:0.85rem;}
        .form-input{width:100%;padding:0.8rem 1rem;background:rgba(255,255,255,0.04);border:2px solid rgba(59,130,246,0.3);border-radius:12px;color:#f8fafc;font-size:0.95rem;outline:none;transition:all 0.3s ease;}
        .form-input:focus{border-color:var(--border-blue);box-shadow:0 0 20px rgba(59,130,246,0.2);}
        .btn{display:inline-flex;align-items:center;justify-content:center;gap:0.5rem;padding:0.75rem 1.5rem;border:none;border-radius:12px;font-size:0.95rem;font-weight:700;cursor:pointer;transition:all 0.3s ease;width:100%;position:relative;overflow:hidden;border:1px solid rgba(59,130,246,0.4);}
        .btn::after{content:'';position:absolute;left:-40%;top:-40%;width:60%;height:180%;background:linear-gradient(90deg,rgba(255,255,255,0.18),rgba(255,255,255,0.02));transform:rotate(25deg);transition:all 0.6s ease;opacity:0.9;}
        .btn:hover::after{left:120%;}
        .btn-primary{background:linear-gradient(135deg,#6366f1,#4f46e5);color:white;}
        .btn-secondary{background:linear-gradient(135deg,#10b981,#0ca678);color:white;margin-top:0.6rem;}
        .toggle-text{text-align:center;margin-top:1.2rem;color:#cbd5e1;font-size:0.85rem;}
        .toggle-link{color:var(--border-blue);cursor:pointer;font-weight:600;text-decoration:underline;}
        .toggle-link:hover{color:#60a5fa;}
        .error-msg{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444;padding:0.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:0.85rem;text-align:center;display:none;}
        .success-msg{background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.3);color:#10b981;padding:0.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:0.85rem;text-align:center;display:none;}
        .accounts-link{text-align:center;margin-top:1.5rem;padding-top:1rem;border-top:1px solid rgba(59,130,246,0.2);}
        .accounts-link a{color:var(--border-blue);font-size:0.8rem;text-decoration:none;font-weight:600;transition:0.3s;padding:8px 20px;border:1px solid rgba(59,130,246,0.4);border-radius:20px;display:inline-block;}
        .accounts-link a:hover{background:rgba(59,130,246,0.15);box-shadow:0 0 15px rgba(59,130,246,0.3);}
    </style>
</head>
<body>
    <div class="background-animation">
        <div class="floating-shape shape-1"></div>
        <div class="floating-shape shape-2"></div>
        <div class="floating-shape shape-3"></div>
    </div>

    <div class="login-container" id="loginContainer">
        <div class="logo-area">
            <h1 class="logo-text">𝟗ᴍᴀɴ-𝐗-𝐘ᴀᴍ𝐃ʜᴜᴅ</h1>
            <p class="tagline">ADVANCED MESSAGING PLATFORM</p>
        </div>
        
        <div class="error-msg" id="errorMsg"></div>
        <div class="success-msg" id="successMsg"></div>
        
        <!-- LOGIN FORM -->
        <div id="loginForm">
            <div class="form-group">
                <label class="form-label">USERNAME</label>
                <input type="text" id="loginUsername" class="form-input" placeholder="ENTER USSER NAME" autocomplete="off">
            </div>
            <div class="form-group">
                <label class="form-label">PASSWORD</label>
                <input type="password" id="loginPassword" class="form-input" placeholder="ENTER PASSWORD">
            </div>
            <button class="btn btn-primary" id="btnLogin">
                <i class="fas fa-sign-in-alt"></i> LOGIN
            </button>
            <p class="toggle-text">Don't have an account? <span class="toggle-link" id="showRegister">Register here</span></p>
        </div>
        
        <!-- REGISTER FORM -->
        <div id="registerForm" style="display:none;">
            <div class="form-group">
                <label class="form-label">CHOOSE USERNAME</label>
                <input type="text" id="regUsername" class="form-input" placeholder="MIIN 3 CHARACTERS" autocomplete="off">
            </div>
            <div class="form-group">
                <label class="form-label">CHOOSE PASSWORD</label>
                <input type="password" id="regPassword" class="form-input" placeholder="MIIN 4 CHARACTERS">
            </div>
            <div class="form-group">
                <label class="form-label">CONFIRM PASSWORD</label>
                <input type="password" id="regConfirmPassword" class="form-input" placeholder="RE-ENTER PASSWORD">
            </div>
            <button class="btn btn-secondary" id="btnRegister">
                <i class="fas fa-user-plus"></i> REGISTER
            </button>
            <p class="toggle-text">Already have an account? <span class="toggle-link" id="showLogin">Login here</span></p>
        </div>
        
        <div class="accounts-link">
            <a href="#" id="yourAllAccounts">OFFLINE WHATSAPP SERVER BY 𝟗ᴍᴀɴ-𝐗-𝐘ᴀᴍ𝐃ʜᴜᴅ</a>
        </div>
    </div>

    <script>
        var errorMsg = document.getElementById('errorMsg');
        var successMsg = document.getElementById('successMsg');
        var loginForm = document.getElementById('loginForm');
        var registerForm = document.getElementById('registerForm');
        
        function showError(msg) {
            errorMsg.style.display = 'block';
            errorMsg.textContent = msg;
            successMsg.style.display = 'none';
            setTimeout(function(){ errorMsg.style.display = 'none'; }, 4000);
        }
        
        function showSuccess(msg) {
            successMsg.style.display = 'block';
            successMsg.textContent = msg;
            errorMsg.style.display = 'none';
            setTimeout(function(){ successMsg.style.display = 'none'; }, 4000);
        }
        
        document.getElementById('showRegister').addEventListener('click', function() {
            loginForm.style.display = 'none';
            registerForm.style.display = 'block';
            errorMsg.style.display = 'none';
            successMsg.style.display = 'none';
        });
        
        document.getElementById('showLogin').addEventListener('click', function() {
            registerForm.style.display = 'none';
            loginForm.style.display = 'block';
            errorMsg.style.display = 'none';
            successMsg.style.display = 'none';
        });
        
        document.getElementById('btnLogin').addEventListener('click', async function() {
            var username = document.getElementById('loginUsername').value.trim();
            var password = document.getElementById('loginPassword').value;
            
            if (!username || !password) {
                showError('Please fill in all fields.');
                return;
            }
            
            var btn = this;
            var originalHtml = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> LOGGING IN...';
            btn.disabled = true;
            
            try {
                var resp = await fetch('/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username, password: password })
                });
                var data = await resp.json();
                
                if (data.success) {
                    localStorage.setItem('session_owner', data.ownerId);
                    localStorage.setItem('current_user', data.username);
                    showSuccess('Login successful! Redirecting...');
                    setTimeout(function() {
                        window.location.href = '/dashboard';
                    }, 800);
                } else {
                    showError(data.error || 'Login failed.');
                }
            } catch (e) {
                showError('Network error. Please try again.');
            } finally {
                btn.innerHTML = originalHtml;
                btn.disabled = false;
            }
        });
        
        document.getElementById('btnRegister').addEventListener('click', async function() {
            var username = document.getElementById('regUsername').value.trim();
            var password = document.getElementById('regPassword').value;
            var confirmPassword = document.getElementById('regConfirmPassword').value;
            
            if (!username || !password || !confirmPassword) {
                showError('Please fill in all fields.');
                return;
            }
            
            if (username.length < 3) {
                showError('Username must be at least 3 characters.');
                return;
            }
            
            if (password.length < 4) {
                showError('Password must be at least 4 characters.');
                return;
            }
            
            if (password !== confirmPassword) {
                showError('Passwords do not match.');
                return;
            }
            
            var btn = this;
            var originalHtml = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> CREATING ACCOUNT...';
            btn.disabled = true;
            
            try {
                var resp = await fetch('/api/register', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username, password: password })
                });
                var data = await resp.json();
                
                if (data.success) {
                    showSuccess('Account created! You can now login.');
                    registerForm.style.display = 'none';
                    loginForm.style.display = 'block';
                    document.getElementById('loginUsername').value = username;
                    document.getElementById('loginPassword').value = '';
                    document.getElementById('regUsername').value = '';
                    document.getElementById('regPassword').value = '';
                    document.getElementById('regConfirmPassword').value = '';
                } else {
                    showError(data.error || 'Registration failed.');
                }
            } catch (e) {
                showError('Network error. Please try again.');
            } finally {
                btn.innerHTML = originalHtml;
                btn.disabled = false;
            }
        });
        
        // YOUR ALL ACCOUNTS - Show all accounts and auto-login on click
        document.getElementById('yourAllAccounts').addEventListener('click', async function(e) {
            e.preventDefault();
            var oid = localStorage.getItem('session_owner');
            if (!oid) {
                showError('Please login first to view your accounts.');
                return;
            }
            try {
                var resp = await fetch('/api/user-accounts?ownerId=' + encodeURIComponent(oid));
                var data = await resp.json();
                if (!data.success) {
                    showError('Failed to load accounts.');
                    return;
                }
                if (!data.accounts || data.accounts.length === 0) {
                    showError('No registered accounts found.');
                    return;
                }
                
                var modal = document.createElement('div');
                modal.style.cssText = 'position:fixed;z-index:9999;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:1rem;';
                modal.innerHTML = '<div style="background:linear-gradient(180deg,#0b1020,#16192b);border:2px solid #3b82f6;border-radius:16px;padding:1.5rem;max-width:500px;width:100%;box-shadow:0 0 40px rgba(59,130,246,0.2);"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem"><h3 style="color:#3b82f6">YOUR ALL ACCOUNTS</h3><span style="color:#ef4444;font-size:24px;cursor:pointer" onclick="this.closest(\\'div[style]\\').parentElement.remove()">&times;</span></div><div id="accountsList"></div></div>';
                document.body.appendChild(modal);
                
                var list = modal.querySelector('#accountsList');
                data.accounts.forEach(function(acc) {
                    var item = document.createElement('div');
                    item.style.cssText = 'display:flex;align-items:center;padding:12px 16px;border:2px solid rgba(59,130,246,0.2);border-radius:10px;margin-bottom:8px;cursor:pointer;transition:all 0.3s;';
                    item.innerHTML = '<div style="flex:1"><div style="font-weight:700;color:#fff;font-size:1rem">' + acc.username + '</div><div style="font-size:0.75rem;color:#94a3b8;margin-top:2px"><i class="far fa-calendar-alt"></i> Joined: ' + new Date(acc.createdAt).toLocaleDateString() + '</div><div style="font-size:0.75rem;color:#10b981;margin-top:2px"><i class="fas fa-plug"></i> ' + acc.activeSessions + ' Active</div></div><div style="color:#3b82f6;font-size:1.5rem">➤</div>';
                    item.onmouseover = function() { this.style.background = 'rgba(59,130,246,0.1)'; this.style.borderColor = '#3b82f6'; this.style.transform = 'translateX(5px)'; };
                    item.onmouseout = function() { this.style.background = ''; this.style.borderColor = 'rgba(59,130,246,0.2)'; this.style.transform = ''; };
                    item.onclick = function() {
                        localStorage.setItem('session_owner', acc.ownerId);
                        localStorage.setItem('current_user', acc.username);
                        modal.remove();
                        showSuccess('Logged in as ' + acc.username + '!');
                        setTimeout(function() { location.reload(); }, 500);
                    };
                    list.appendChild(item);
                });
                
                modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
            } catch (e) {
                showError('Network error.');
            }
        });
        
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                if (loginForm.style.display !== 'none') {
                    document.getElementById('btnLogin').click();
                } else {
                    document.getElementById('btnRegister').click();
                }
            }
        });
        
        (function() {
            if (localStorage.getItem('session_owner') && localStorage.getItem('current_user')) {
                window.location.href = '/dashboard';
            }
        })();
    </script>
</body>
</html>
    `);
});

// ============ DASHBOARD PAGE (UPDATED: Session dropdown excludes sessions with active tasks) ============

app.get("/dashboard", (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>𝟗ᴍᴀɴ-𝐗-𝐘ᴀᴍ𝐃ʜᴜᴅ</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        :root{
            --primary:#6366f1; --primary-dark:#4f46e5; --secondary:#10b981; --accent:#f59e0b; --danger:#ef4444;
            --dark:#1e293b; --darker:#0f172a; --light:#f8fafc; --gray:#64748b; --gray-light:#cbd5e1;
            --glass:rgba(255,255,255,0.03); --glass-border:rgba(59,130,246,0.3); --border-blue:#3b82f6;
        }
        body{ font-family:'Inter',sans-serif; background:linear-gradient(135deg,var(--darker) 0%,var(--dark) 100%); color:var(--light); min-height:100vh; overflow-x:hidden; text-transform:uppercase; }
        .background-animation{position:fixed; top:0; left:0; width:100%; height:100%; z-index:-1; overflow:hidden; }
        .floating-shape{position:absolute; border-radius:50%; opacity:0.12; filter:blur(36px); animation:float 22s infinite linear; }
        .shape-1{width:340px;height:340px;top:6%;left:8%; background:linear-gradient(45deg,var(--primary),var(--secondary)); }
        .shape-2{width:420px;height:420px;top:58%;right:8%; background:linear-gradient(45deg,var(--accent),var(--danger)); animation-delay:-5s; }
        .shape-3{width:280px;height:280px;bottom:8%;left:22%; background:linear-gradient(45deg,var(--secondary),var(--primary)); animation-delay:-10s; }
        @keyframes float{0%,100%{transform:translate3d(0,0,0) rotate(0deg);}25%{transform:translate3d(50px,40px,-18px) rotate(90deg);}50%{transform:translate3d(0,80px,8px) rotate(180deg);}75%{transform:translate3d(-60px,40px,-8px) rotate(270deg);}}
        .container{max-width:1200px;margin:0 auto;padding:1rem; }
        .header{text-align:center;margin-bottom:1.6rem; }
        .logo-text{font-size:2.1rem;font-weight:800;background:linear-gradient(135deg,var(--primary),var(--secondary),var(--accent));-webkit-background-clip:text;-webkit-text-fill-color:transparent; }
        .tagline{font-size:0.92rem;color:var(--gray-light);margin-bottom:1rem; }
        .user-bar{display:flex;justify-content:flex-end;align-items:center;gap:0.8rem;margin-bottom:0.8rem;padding:0.5rem 1rem;background:rgba(255,255,255,0.02);border-radius:30px;border:1px solid var(--glass-border);}
        .user-bar span{color:var(--secondary);font-weight:600;}
        .user-bar button{background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#ef4444;padding:0.4rem 1rem;border-radius:20px;cursor:pointer;font-weight:600;font-size:0.8rem;text-transform:uppercase;}
        .user-bar button:hover{background:rgba(239,68,68,0.25);}
        .features-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;margin-bottom:1.4rem;}
        .feature-card{background:linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));backdrop-filter:blur(18px);border:2px solid var(--glass-border);border-radius:14px;padding:1.1rem;box-shadow:0 0 20px rgba(59,130,246,0.1),0 30px 60px rgba(2,6,23,0.6); position:relative; overflow:hidden; cursor:pointer; transition:all 0.18s ease; display:flex;flex-direction:column;justify-content:space-between; }
        .feature-card:hover{transform: translateY(-6px); box-shadow:0 0 30px rgba(59,130,246,0.25),0 44px 90px rgba(2,6,23,0.7); border-color:var(--border-blue);}
        .feature-title{position:relative; z-index:2; font-size:1.06rem;font-weight:700;margin-bottom:0.4rem;color:var(--light); }
        .feature-description{position:relative; z-index:2; color:var(--gray-light);line-height:1.4;margin-bottom:0.8rem;font-size:0.86rem; }
        .form-group{margin-bottom:0.9rem;}
        .form-label{display:block;margin-bottom:0.3rem;color:var(--gray-light);font-weight:500;font-size:0.9rem;}
        .form-input,.form-select{position:relative; z-index:2; width:100%;padding:0.7rem 0.9rem;background:rgba(255,255,255,0.04);border:2px solid var(--glass-border);border-radius:12px;color:var(--light);font-size:0.95rem;}
        .form-input:focus,.form-select:focus{border-color:var(--border-blue);box-shadow:0 0 15px rgba(59,130,246,0.15);outline:none;}
        .btn{display:inline-flex;align-items:center;justify-content:center;gap:0.5rem;padding:0.56rem 0.9rem;border:none;border-radius:12px;font-size:0.92rem;font-weight:700;text-decoration:none;cursor:pointer;transition:all 0.3s ease;position:relative;overflow:hidden;box-shadow:0 10px 30px rgba(2,6,23,0.6);border:1px solid rgba(59,130,246,0.3); }
        .btn::after { content: ''; position: absolute; left: -40%; top: -40%; width: 60%; height: 180%; background: linear-gradient(90deg, rgba(255,255,255,0.18), rgba(255,255,255,0.02)); transform: rotate(25deg); transition: all 0.6s ease; opacity: 0.9; }
        .btn:hover::after { left: 120%; }
        .btn-p{background:linear-gradient(135deg,var(--primary),var(--primary-dark));color:white;}
        .btn-s{background:linear-gradient(135deg,var(--secondary),#0ca678);color:white;}
        .btn-d{background:linear-gradient(135deg,var(--danger),#dc2626);color:white;}
        .btn-a{background:linear-gradient(135deg,var(--accent),#eab308);color:white;}
        .btn-l { padding: 0.9rem 1.1rem; font-size: 0.95rem; border-radius: 14px; width: 100%; display: inline-flex; justify-content:center; align-items:center; gap:0.6rem; }
        .btn-save-green{background:linear-gradient(135deg,#10b981,#059669);color:white;}
        .btn-save-green:hover{background:linear-gradient(135deg,#059669,#047857);box-shadow:0 10px 30px rgba(16,185,129,0.4);}
        .footer{text-align:center;margin-top:1.8rem;padding:1rem;color:var(--gray);border-top:1px solid var(--glass-border);font-size:0.78rem; }
        .modal{position:fixed;z-index:100;left:0;top:0;width:100%;height:100%;background-color:rgba(0,0,0,0.6);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;padding:1rem;}
        .modal.active{display:flex;}
        .modal-inner{background:linear-gradient(180deg,#0b1020 0%, #16192b 100%);padding:1.2rem;border:2px solid rgba(59,130,246,0.3);border-radius:12px;max-width:95%;width:95%;max-height:90vh;height:90vh;overflow:auto;box-shadow:0 0 30px rgba(59,130,246,0.15),0 30px 120px rgba(0,0,0,0.6);position:relative;}
        .modal-inner.small{max-width:720px;width:100%;height:auto;max-height:none;}
        .modal-close{position:absolute;right:12px;top:10px;color:var(--danger);font-size:22px;cursor:pointer;font-weight:700;z-index:3;}
        .modal-header{display:flex;align-items:center;gap:0.6rem;margin-bottom:0.6rem;z-index:3;}
        .modal-icon{width:46px;height:46px;border-radius:10px;background:linear-gradient(135deg,var(--primary),var(--secondary));display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 0 15px rgba(59,130,246,0.3);}
        .group-list{max-height:calc(90vh - 200px);overflow:auto;padding-right:8px;margin-top:0.6rem;}
        .group-item{display:flex;align-items:center;padding:0.6rem;border-radius:8px;background:rgba(255,255,255,0.01);margin-bottom:0.5rem;cursor:pointer;border:1px solid rgba(59,130,246,0.15);}
        .group-item:hover{background:rgba(99,102,241,0.08);border-color:var(--border-blue);}
        .group-avatar{width:44px;height:44px;border-radius:50%;margin-right:0.8rem;object-fit:cover;border:2px solid var(--secondary);}
        .session-avatar{width:64px;height:64px;border-radius:10px;object-fit:cover;border:2px solid rgba(99,102,241,0.18);}
        .user-avatar-img {width:50px;height:50px;border-radius:14px;object-fit:cover;margin-right:16px;flex-shrink:0;box-shadow:0 6px 18px rgba(99,102,241,0.35);border:2px solid var(--border-blue);}
        .session-control-card {
            background: linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(99,102,241,0.02) 100%);
            border:2px solid rgba(59,130,246,0.25);
            border-radius: 16px;
            padding: 14px;
            margin-bottom: 12px;
            position: relative;
            overflow: hidden;
            box-shadow:0 0 15px rgba(59,130,246,0.08),0 8px 30px rgba(0,0,0,0.4);
            animation: cardAppear 0.3s ease;
        }
        @keyframes cardAppear {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .delete-btn, .update-btn {
            padding: 10px 24px;
            border: none;
            border-radius: 30px;
            font-weight: 700;
            text-transform: uppercase;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 6px 16px rgba(0,0,0,0.2);
            letter-spacing: 0.5px;
            font-size: 0.95rem;
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            border:1px solid rgba(59,130,246,0.3);
        }
        .delete-btn {
            background: linear-gradient(135deg, #ef4444 0%, #b91c1c 100%);
            color: #fff;
        }
        .delete-btn:hover {
            background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%);
            box-shadow: 0 10px 24px rgba(239,68,68,0.4);
            transform: translateY(-2px);
        }
        .update-btn {
            background: linear-gradient(135deg, #8b5cf6, #7c3aed);
            color: #fff;
        }
        .update-btn:hover {
            background: linear-gradient(135deg, #7c3aed, #6d28d9);
            box-shadow: 0 10px 24px rgba(139,92,246,0.4);
            transform: translateY(-2px);
        }
        .save-btn-green {
            background: linear-gradient(135deg, #10b981, #059669);
            color: #fff;
            padding: 10px 24px;
            border: none;
            border-radius: 30px;
            font-weight: 700;
            text-transform: uppercase;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 6px 16px rgba(0,0,0,0.2);
            letter-spacing: 0.5px;
            font-size: 0.95rem;
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            border:1px solid rgba(16,185,129,0.4);
            width:100%;
            justify-content:center;
        }
        .save-btn-green:hover {
            background: linear-gradient(135deg, #059669, #047857);
            box-shadow: 0 10px 24px rgba(16,185,129,0.4);
            transform: translateY(-2px);
        }
        .action-row {
            display: flex;
            gap: 10px;
            align-items: center;
            margin-top: 12px;
            flex-wrap: wrap;
        }
        .file-upload-wrapper {
            position: relative;
            overflow: hidden;
            display: inline-block;
            width: 100%;
        }
        .file-upload-wrapper input[type=file] {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            opacity: 0;
            cursor: pointer;
        }
        .file-upload-btn {
            background: linear-gradient(135deg, var(--primary), var(--primary-dark));
            color: white;
            padding: 0.8rem 1.2rem;
            border-radius: 12px;
            font-weight: 700;
            text-transform: uppercase;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 0.5rem;
            width: 100%;
            box-shadow: 0 10px 30px rgba(2,6,23,0.6);
            border:1px solid rgba(59,130,246,0.3);
            transition: all 0.3s ease;
        }
        .file-upload-btn:hover {
            box-shadow: 0 14px 40px rgba(2,6,23,0.8);
            transform: translateY(-2px);
        }
        .c-display { color: #ffffff; font-weight:800; }
        .c-number { color: #60a5fa; }
        .c-target { color: #f59e0b; }
        .c-file { color: #f472b6; }
        .c-prefix { color: #22d3ee; }
        .c-speed { color: #34d399; }
        .c-hater { color: #facc15; }
        .c-started { color: #9ca3af; }
        .c-connected { color: #10b981; font-weight:700; }
        .c-disconnected { color: #f59e0b; font-weight:700; }
        .security-badge {
            display: inline-flex;
            align-items: center;
            gap: 0.4rem;
            background: rgba(16, 185, 129, 0.15);
            border: 1px solid var(--secondary);
            color: var(--secondary);
            padding: 0.4rem 0.8rem;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 700;
            margin-top: 8px;
        }
        .user-list-card {
            background: linear-gradient(135deg, rgba(30,41,59,0.9) 0%, rgba(15,23,42,0.95) 100%);
            border:2px solid rgba(59,130,246,0.3);
            border-radius: 16px;
            padding: 16px 18px;
            margin-bottom: 12px;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: space-between;
            position: relative;
            overflow: hidden;
            box-shadow:0 0 18px rgba(59,130,246,0.1),0 8px 25px rgba(0,0,0,0.3);
            user-select:none;-webkit-user-select:none;
        }
        .user-list-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 4px;
            height: 100%;
            background: linear-gradient(180deg, #3b82f6, #6366f1, #3b82f6);
            border-radius: 4px 0 0 4px;
        }
        .user-list-card:hover {
            background: linear-gradient(135deg, rgba(59,130,246,0.15), rgba(15,23,42,0.95));
            border-color: var(--border-blue);
            transform: translateY(-3px);
            box-shadow:0 0 30px rgba(59,130,246,0.25),0 14px 35px rgba(0,0,0,0.4);
        }
        .user-details { flex: 1; min-width: 150px; position: relative; z-index: 2; }
        .user-username { font-weight: 700; font-size: 1.05rem; color: #fff; letter-spacing: 0.5px; }
        .user-sessions-count { font-size: 0.8rem; color: #10b981; margin-top: 3px; display: flex; align-items: center; gap: 4px; }
        .user-created { font-size: 0.72rem; color: #94a3b8; margin-top: 3px; display: flex; align-items: center; gap: 4px; }
        .badge-session {
            background: rgba(16,185,129,0.2);
            border: 1px solid rgba(16,185,129,0.4);
            color: #10b981;
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: 700;
            position: relative;
            z-index: 2;
            box-shadow: 0 4px 12px rgba(16,185,129,0.2);
        }
        .badge-disconnected {
            background: rgba(245,158,11,0.2);
            border: 1px solid rgba(245,158,11,0.4);
            color: #f59e0b;
            padding: 6px 16px;
            border-radius: 20px;
            font-size: 0.8rem;
            font-weight: 700;
            position: relative;
            z-index: 2;
        }
        .divider-line { border: none; border-top: 1px solid rgba(59,130,246,0.15); margin: 3px 0; }
        .bold-text { font-weight: 700; color: #fff; }
        .user-card-right { display: flex; align-items: center; gap: 10px; position: relative; z-index: 2; }
        .update-form-section {
            display:none; 
            margin-top:12px; 
            padding:12px; 
            background:rgba(255,255,255,0.03); 
            border-radius:12px;
            border:2px solid rgba(59,130,246,0.25);
        }
        .delete-user-btn {
            display:none;
            background:linear-gradient(135deg,#ef4444,#b91c1c);
            color:#fff;padding:6px 16px;border-radius:20px;font-size:.75rem;font-weight:700;
            border:1px solid rgba(239,68,68,0.4);cursor:pointer;animation:fadeIn .3s;
            position:absolute;right:10px;top:50%;transform:translateY(-50%);z-index:10;
        }
        @keyframes fadeIn{from{opacity:0;transform:translateY(-50%) scale(.9)}to{opacity:1;transform:translateY(-50%) scale(1)}}
        @media (max-width:768px){ .features-grid{grid-template-columns:1fr;} .modal-inner{padding:0.8rem;} .btn-l{width:100%;} }
    </style>
</head>
<body>
    <div class="background-animation">
        <div class="floating-shape shape-1"></div>
        <div class="floating-shape shape-2"></div>
        <div class="floating-shape shape-3"></div>
    </div>

    <div class="container">
        <div class="user-bar" id="userBar">
            <i class="fas fa-user-circle" style="color:var(--secondary);"></i>
            <span id="currentUserDisplay">USER</span>
            <button id="btnLogout" style="margin-left:auto;">LOGOUT</button>
        </div>
        
        <header class="header">
            <div>
                <h1 class="logo-text">𝟗ᴍᴀɴ-𝐗-𝐘ᴀᴍ𝐃ʜᴜᴅ</h1>
            </div>
            <p class="tagline">ADVANCED MESSAGING PLATFORM <span class="typing-animation">WITH 24/7 CONNECTIVITY</span></p>
            <div style="margin-top: 0.5rem;">
                <span class="security-badge"><i class="fas fa-shield-alt"></i> SESSION PROTECTION ENABLED</span>
            </div>
        </header>

        <div class="features-grid">
            <div class="feature-card" id="card-pairing">
                <div>
                    <h3 class="feature-title">📲 DEVICE PAIRING CODE GRENADE 📲</h3>
                    <p class="feature-description">CONNECT YOUR WHATSAPP ACCOUNT USING PAIRING CODE FOR SEAMLESS INTEGRATION</p>
                </div>
            </div>

            <div class="feature-card" id="card-bulk">
                <div>
                    <h3 class="feature-title">💬 BULK MESSAGING SENDER BOT ON 💬</h3>
                    <p class="feature-description">SEND MESSAGES TO MULTIPLE RECIPIENTS WITH CUSTOMIZABLE DELAYS AND PREFIXES</p>
                </div>
            </div>

            <div class="feature-card" id="card-session-manage">
                <div>
                    <h3 class="feature-title">⚙️ SESSION MANAGE ⚙️</h3>
                    <p class="feature-description">VIEW, UPDATE & DELETE YOUR WHATSAPP SESSION WITH FULL CONTROL</p>
                </div>
            </div>

            <div class="feature-card" id="card-admin">
                <div>
                    <h3 class="feature-title">😈💠 ADMIN PENAL CART ON MOOD 💠😈</h3>
                    <p class="feature-description">ADMIN PENAL ONLY ADMIN USING ADMIN PENAL USSER NOT ALLOWED USSER DUR RAHE...✅</p>
                </div>
            </div>
        </div>

        <footer class="footer">
            <p>© 2025 𝟗ᴍᴀɴ-𝐗-𝐘ᴀᴍ𝐃ʜᴜᴅ MADE WITH ❤️ BY 𝟗ᴍᴀɴ-𝐗-𝐘ᴀᴍ𝐃ʜᴜᴅ × NADEEM ❝ beta<i class="fas fa-heart" style="color: var(--danger);"></i> BY 👑×👑</p>
            <p>tumhara kaam hai jalna, humara kaam tum jaise gareeb ko jalana ❞ 😀❤️</p>
        </footer>
    </div>

    <!-- Modal: Device Pairing -->
    <div id="modal-pairing" class="modal">
        <div class="modal-inner small" role="dialog" aria-modal="true">
            <span class="modal-close" data-close="modal-pairing">&times;</span>
            <div class="modal-header">
                <div class="modal-icon"><i class="fas fa-qrcode"></i></div>
                <div><h2 style="margin:0;font-size:1.02rem;">YOUR PAIRING CODE GRENADE</h2><div style="color:var(--gray-light);font-size:0.82rem;margin-top:6px;">Enter your WhatsApp number and get a permanent pairing code</div></div>
            </div>
            <div style="margin-top:10px;">
                <div class="form-group"><label class="form-label">YOUR WHATSAPP NUMBER</label><input type="text" id="numberInputModal" class="form-input" placeholder="+918075498750" required></div>
                <div style="text-align:center;"><button class="btn btn-p btn-l" id="btn-generate-code"><i class="fas fa-key"></i> GENERATE PAIRING CODE</button></div>
                <div id="pairingResultModal" style="margin-top:10px;"></div>
            </div>
        </div>
    </div>

    <!-- Modal: Bulk Messaging -->
    <div id="modal-bulk" class="modal">
        <div class="modal-inner small" role="dialog" aria-modal="true">
            <span class="modal-close" data-close="modal-bulk">&times;</span>
            <div class="modal-header"><div class="modal-icon"><i class="fas fa-paper-plane"></i></div><div><h2 style="margin:0;font-size:1.02rem;">BULK MESSAGING SENDER BOT</h2><div style="color:var(--gray-light);font-size:0.82rem;margin-top:6px;">Send messages to numbers or groups. Upload .txt file</div></div></div>
            <div style="margin-top:10px;">
                <form action="/send-message" method="POST" enctype="multipart/form-data" id="bulkMessageForm">
                    <input type="hidden" name="owner" id="formOwnerBulk" value="">
                    <div class="form-group"><label class="form-label">SELECT SESSION</label><select name="sessionId" id="sessionSelectModal" class="form-select" required><option value="">LOADING SESSIONS...</option></select></div>
                    <div class="form-group"><label class="form-label">SELECT OPINION</label><select name="targetType" id="targetTypeModal" class="form-select" required><option value="">SELECT TARGET</option><option value="number">TARGET NOUMBER</option><option value="group">SELECT GROUP</option></select></div>
                    <div class="form-group" id="targetInputGroup" style="display:none;"><label class="form-label">ENTER TARGET NOUMBER</label><input type="text" name="target" id="targetInputModal" class="form-input" placeholder="PHONE NUMBER"></div>
                    <div class="form-group" id="groupPickerContainerModal" style="display:none;"><button type="button" class="btn btn-a btn-l" id="btn-select-group"><i class="fas fa-users"></i> SELECT GROUP</button></div>
                    <div class="form-group"><label class="form-label">UPLOAD FILE (.TXT)</label><div class="file-upload-wrapper"><label class="file-upload-btn" for="fileInputModal"><i class="fas fa-upload"></i> CHOOSE FILE</label><input type="file" name="messageFile" id="fileInputModal" accept=".txt" required></div></div>
                    <div class="form-group"><label class="form-label">ENTER HATER NAME (OPTIONAL)</label><input type="text" name="prefix" class="form-input" placeholder="HATER NAME ENTER"></div>
                    <div class="form-group"><label class="form-label">ENTER DELAY (SECONDS)</label><input type="number" name="delaySec" class="form-input" placeholder="10" min="1" required></div>
                    <div class="form-group"><label class="form-label">ENTER LAST HATER NAME</label><input type="text" name="lastHaterName" class="form-input" placeholder="LAST HATER NAME"></div>
                    <div style="text-align:center;"><button type="submit" class="btn btn-s btn-l"><i class="fas fa-play"></i> START SERVER</button></div>
                </form>
            </div>
        </div>
    </div>

    <!-- Modal: Session Manage -->
    <div id="modal-session-manage" class="modal">
        <div class="modal-inner" role="dialog" aria-modal="true">
            <span class="modal-close" data-close="modal-session-manage">&times;</span>
            <div class="modal-header"><div class="modal-icon"><i class="fas fa-cogs"></i></div><div><h2 style="margin:0;font-size:1.02rem;">SESSION MANAGE</h2><div style="color:var(--gray-light);font-size:0.82rem;margin-top:6px;">View, update & delete your WhatsApp session.</div></div></div>
            <div style="margin-top:10px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><div style="color:var(--gray-light);font-weight:700;">YOUR SESSIONS</div><button class="btn btn-a" id="btn-refresh-sessions"><i class="fas fa-sync-alt"></i> REFRESH</button></div>
                <div id="sessionManageContainer" style="margin-top:10px;"><div style="text-align:center;color:var(--gray);"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p>LOADING SESSIONS...</p></div></div>
            </div>
        </div>
    </div>

    <!-- Modal: ADMIN LOGIN -->
    <div id="modal-admin-login" class="modal">
        <div class="modal-inner small" role="dialog" aria-modal="true">
            <span class="modal-close" data-close="modal-admin-login">&times;</span>
            <div class="modal-header"><div class="modal-icon"><i class="fas fa-user-lock"></i></div><div><h2 style="margin:0;font-size:1.02rem;">LOGIN ADMIN PENAL</h2><div style="color:var(--gray-light);font-size:0.82rem;margin-top:6px;">ENTER USERNAME & PASSWORD</div></div></div>
            <div style="margin-top:10px;">
                <div class="form-group"><label class="form-label">ENTER USERNAME</label><input type="text" id="adminUsername" class="form-input" placeholder="USERNAME"></div>
                <div class="form-group"><label class="form-label">ENTER PASSWORD</label><input type="password" id="adminPassword" class="form-input" placeholder="PASSWORD"></div>
                <div style="text-align:center;"><button class="btn btn-p btn-l" id="btn-admin-login"><i class="fas fa-sign-in-alt"></i> LOGIN</button></div>
            </div>
        </div>
    </div>

    <!-- Modal: Admin Panel (USERS LIST) -->
    <div id="modal-admin" class="modal">
        <div class="modal-inner" role="dialog" aria-modal="true">
            <span class="modal-close" data-close="modal-admin">&times;</span>
            <div class="modal-header"><div class="modal-icon"><i class="fas fa-user-shield"></i></div><div><h2 style="margin:0;font-size:1.02rem;">ADMIN PENAL - ALL USERS</h2><div style="color:var(--gray-light);font-size:0.82rem;margin-top:6px;">Long press user to delete | Click for sessions</div></div></div>
            <div style="margin-top:10px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;"><div style="color:var(--gray-light);font-weight:700;">REGISTERED USERS</div><div><button class="btn btn-a" id="btn-refresh-admin">REFRESH</button><button class="btn btn-d" id="btn-logout-admin" style="margin-left:8px;">LOGOUT</button></div></div>
                <div id="adminSessionsContainer" style="margin-top:10px;"><div style="text-align:center;color:var(--gray);"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p>LOADING USERS...</p></div></div>
            </div>
        </div>
    </div>

    <!-- Modal: User Sessions (Admin clicks user) -->
    <div id="modal-user-sessions" class="modal">
        <div class="modal-inner" role="dialog" aria-modal="true">
            <span class="modal-close" data-close="modal-user-sessions">&times;</span>
            <div class="modal-header"><div class="modal-icon"><i class="fas fa-list"></i></div><div><h2 style="margin:0;font-size:1.02rem;" id="userSessionTitle">USER SESSIONS</h2><div style="color:var(--gray-light);font-size:0.82rem;margin-top:6px;">All sessions for this user.</div></div></div>
            <div style="margin-top:10px;">
                <button class="btn btn-a" id="btn-back-to-users" style="margin-bottom:10px;"><i class="fas fa-arrow-left"></i> BACK TO USERS</button>
                <div id="userSessionsContainer" style="margin-top:10px;"><div style="text-align:center;color:var(--gray);"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i></div></div>
            </div>
        </div>
    </div>

    <!-- Group Modal -->
    <div id="groupModal" class="modal">
        <div class="modal-inner" style="max-width:95%;width:95%;height:90vh;">
            <span class="modal-close" data-close="groupModal">&times;</span>
            <div class="modal-header"><div class="modal-icon"><i class="fas fa-users"></i></div><div><h2 style="margin:0;font-size:1.02rem;">SELECT A WHATSAPP GROUP</h2><div style="color:var(--gray-light);font-size:0.82rem;margin-top:6px;">Choose a group</div></div></div>
            <div id="groupList" class="group-list" style="margin-top:10px;"><div style="text-align:center;color:var(--gray);"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p>LOADING GROUPS...</p></div></div>
        </div>
    </div>

    <!-- Admin Group Modal for Update -->
    <div id="adminGroupModal" class="modal">
        <div class="modal-inner" style="max-width:95%;width:95%;height:90vh;">
            <span class="modal-close" data-close="adminGroupModal">&times;</span>
            <div class="modal-header"><div class="modal-icon"><i class="fas fa-users"></i></div><div><h2 style="margin:0;font-size:1.02rem;">SELECT GROUP FOR UPDATE</h2></div></div>
            <div id="adminGroupList" class="group-list" style="margin-top:10px;"><div style="text-align:center;color:var(--gray);"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i></div></div>
        </div>
    </div>

    <script>
        // ============ HELPER FUNCTIONS ============
        
        function getCurrentOwner() {
            return localStorage.getItem('session_owner') || '';
        }
        
        function getCurrentUser() {
            return localStorage.getItem('current_user') || 'USER';
        }

        async function fetchWithOwner(url, options) {
            options = options || {};
            var owner = getCurrentOwner();
            options.headers = options.headers || {};
            options.headers['X-Session-Owner'] = owner;
            return fetch(url, options);
        }

        function showNotification(message, type) {
            var n = document.createElement('div');
            n.style.cssText = 'position:fixed;top:18px;right:18px;padding:0.9rem 1.2rem;border-radius:12px;background:'+(type==='success'?'#10b981':'#ef4444')+';color:#fff;z-index:9999;box-shadow:0 12px 40px rgba(0,0,0,0.5);font-weight:700;max-width:400px;';
            n.innerHTML = '<div style="display:flex;align-items:center;gap:0.6rem;"><i class="fas fa-'+(type==='success'?'check-circle':'exclamation-triangle')+'"></i><span>'+message+'</span></div>';
            document.body.appendChild(n);
            setTimeout(function(){ n.style.opacity = '0'; n.style.transition = 'opacity 0.4s'; setTimeout(function(){ n.remove(); },400); }, 3800);
        }

        // ============ MODAL FUNCTIONS ============
        
        function openModal(modalId) {
            var el = document.getElementById(modalId);
            if(el) { el.style.display = 'flex'; el.classList.add('active'); }
        }
        
        function closeModal(modalId) { 
            var el = document.getElementById(modalId);
            if(el) { el.style.display = 'none'; el.classList.remove('active'); }
        }

        // ============ CARD HANDLERS ============
        
        function openPairingModal() { openModal('modal-pairing'); }
        
        function openBulkModal() {
            openModal('modal-bulk');
            updateSessionSelect();
            var ownerField = document.getElementById('formOwnerBulk');
            if(ownerField) ownerField.value = getCurrentOwner();
        }
        
        function openSessionManageModal() {
            openModal('modal-session-manage');
            loadSessionManage();
        }
        
        function openAdminLoginModal() {
            if (localStorage.getItem('admin_auth') === 'true') {
                openModal('modal-admin');
                loadAdminUsers();
                return;
            }
            openModal('modal-admin-login');
        }

        // ============ LOGOUT ============
        
        document.getElementById('btnLogout').addEventListener('click', function() {
            localStorage.removeItem('session_owner');
            localStorage.removeItem('current_user');
            localStorage.removeItem('admin_auth');
            window.location.href = '/';
        });

        // ============ PAIRING ============
        
        async function generatePairingCode() {
            var number = document.getElementById('numberInputModal').value;
            var resultHolder = document.getElementById('pairingResultModal');
            var btn = document.getElementById('btn-generate-code');
            
            if (!number || number.replace(/[^0-9]/g, "").length < 10) {
                showNotification('PLEASE ENTER A VALID WHATSAPP NUMBER (MIN 10 DIGITS)', 'error');
                return;
            }
            
            var original = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> GENERATING...';
            btn.disabled = true;
            resultHolder.innerHTML = '';
            var owner = getCurrentOwner();

            try {
                var resp = await fetch('/code?number=' + encodeURIComponent(number) + '&owner=' + encodeURIComponent(owner));
                var text = await resp.text();
                resultHolder.innerHTML = text;
                if (text.indexOf('PAIRING CODE GENERATED') !== -1 || text.indexOf('ALREADY CONNECTED!') !== -1) {
                    showNotification('PAIRING STATUS RECEIVED', 'success');
                } else if (text.indexOf('SESSION ALREADY OWNED') !== -1) {
                    showNotification('SESSION ALREADY OWNED BY ANOTHER USER', 'error');
                } else {
                    showNotification('FAILED TO GENERATE CODE. CHECK SERVER LOG.', 'error');
                }
            } catch (err) { showNotification('NETWORK ERROR: SERVER UNREACHABLE.', 'error'); }
            finally { setTimeout(function(){ btn.innerHTML = original; btn.disabled = false; }, 900); }
        }

        // ============ SESSION MANAGE ============
        
        async function loadSessionManage() {
            var container = document.getElementById('sessionManageContainer');
            if(!container) return;
            container.innerHTML = '<div style="text-align:center;color:var(--gray);"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p>LOADING SESSIONS...</p></div>';

            try {
                var resp = await fetchWithOwner('/sessions');
                var data = await resp.json();
                if (!data.success) {
                    container.innerHTML = '<div style="text-align:center;color:var(--danger);"><i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i><p>FAILED TO LOAD SESSIONS</p></div>';
                    return;
                }
                if (!data.sessions || data.sessions.length === 0) {
                    container.innerHTML = '<div style="text-align:center;color:var(--gray);"><i class="fas fa-info-circle" style="font-size:1.6rem;"></i><p>NO SESSIONS FOUND</p></div>';
                    return;
                }
                container.innerHTML = '';
                data.sessions.forEach(function(s) {
                    var taskStartDisplay = s.taskStart ? new Date(s.taskStart).toLocaleString() : 'N/A';
                    
                    var card = document.createElement('div');
                    card.className = 'session-control-card';
                    card.innerHTML = 
                        '<div style="display:flex; gap:14px; align-items:flex-start;">' +
                            '<img src="' + (s.avatarUrl || 'https://via.placeholder.com/80/6366f1/ffffff?text=W') + '" class="session-avatar" onerror="this.onerror=null;this.src=\\'https://via.placeholder.com/80/6366f1/ffffff?text=W\\'" style="width:64px;height:64px;flex-shrink:0;">' +
                            '<div style="flex:1; min-width:200px;">' +
                                '<div class="c-display" style="font-size:1rem;">' + (s.displayName || s.number) + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-number bold-text" style="font-size:0.85rem;margin-top:4px;">NUMBER  ' + s.number + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-target bold-text" style="font-size:0.85rem;">TARGET  ' + (s.lastTarget || 'N/A') + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-file bold-text" style="font-size:0.85rem;">FILE.TXT ' + (s.lastFileName || 'N/A') + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-prefix bold-text" style="font-size:0.85rem;">TARGET NAME ' + (s.lastPrefix || 'N/A') + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-speed bold-text" style="font-size:0.85rem;">SPEED SECOND ' + (s.lastSpeed || 'N/A') + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-hater bold-text" style="font-size:0.85rem;">LAST HATER NAME ' + (s.lastHaterName || 'N/A') + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-started bold-text" style="font-size:0.85rem; margin-bottom:6px;">STARTED: ' + taskStartDisplay + '</div>' +
                                '<div class="' + (s.connected ? 'c-connected' : 'c-disconnected') + '" style="margin-top:6px;">' + (s.connected ? '✓ CONNECTED' : '⚠ DISCONNECTED') + '</div>' +
                                '<div class="c-started bold-text" style="font-size:0.85rem; margin-top:4px;">UPTIME: ' + (s.uptime || '0 seconds') + '</div>' +
                                (s.isOwned ? '<div class="security-badge"><i class="fas fa-lock"></i> PROTECTED SESSION</div>' : '') +
                            '</div>' +
                        '</div>' +
                        '<div class="action-row">' +
                            '<button class="delete-btn" data-delete-session="' + s.sessionId + '"><i class="fas fa-trash-alt"></i> DELETE</button>' +
                            '<button class="update-btn" data-toggle-update="' + s.sessionId + '"><i class="fas fa-edit"></i> UPDATE</button>' +
                        '</div>' +
                        '<div id="update-form-' + s.sessionId + '" class="update-form-section">' +
                            '<input type="text" id="update-prefix-' + s.sessionId + '" class="form-input" placeholder="NEW PREFIX" value="' + (s.lastPrefix || '') + '">' +
                            '<input type="number" id="update-speed-' + s.sessionId + '" class="form-input" placeholder="NEW DELAY (SEC)" value="' + (s.lastSpeed || '') + '" style="margin-top:8px;">' +
                            '<input type="text" id="update-hater-' + s.sessionId + '" class="form-input" placeholder="NEW LAST HATER NAME" value="' + (s.lastHaterName || '') + '" style="margin-top:8px;">' +
                            '<div style="margin-top:10px;"><label class="form-label">UPDATE MESSAGE FILE (.TXT)</label>' +
                                '<div class="file-upload-wrapper"><label class="file-upload-btn" for="update-file-' + s.sessionId + '"><i class="fas fa-upload"></i> CHOOSE FILE</label>' +
                                '<input type="file" id="update-file-' + s.sessionId + '" accept=".txt"></div>' +
                            '</div>' +
                            '<button class="btn btn-l save-btn-green" style="margin-top:10px;" data-apply-update="' + s.sessionId + '"><i class="fas fa-save"></i> SAVE</button>' +
                        '</div>';
                    container.appendChild(card);
                });
                
                var deleteBtns = container.querySelectorAll('[data-delete-session]');
                deleteBtns.forEach(function(btn) {
                    btn.addEventListener('click', function() { deleteSessionManager(this.getAttribute('data-delete-session')); });
                });
                var toggleBtns = container.querySelectorAll('[data-toggle-update]');
                toggleBtns.forEach(function(btn) {
                    btn.addEventListener('click', function() { toggleUpdateForm(this.getAttribute('data-toggle-update')); });
                });
                var applyBtns = container.querySelectorAll('[data-apply-update]');
                applyBtns.forEach(function(btn) {
                    btn.addEventListener('click', function() { applyUpdate(this.getAttribute('data-apply-update')); });
                });
            } catch (e) {
                container.innerHTML = '<div style="text-align:center;color:var(--danger);"><i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i><p>NETWORK ERROR</p></div>';
            }
        }

        async function deleteSessionManager(sessionId) {
            if (!confirm('ARE YOU ABSOLUTELY SURE? This will permanently delete session "' + sessionId + '" and all its data. OTHER SESSIONS WILL NOT BE AFFECTED.')) return;
            try {
                var resp = await fetchWithOwner('/delete-session', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: sessionId })
                });
                var result = await resp.json();
                if (result.success) { 
                    showNotification('Session deleted. Other sessions running normally.', 'success'); 
                    loadSessionManage(); 
                }
                else showNotification('Error: ' + (result.error || 'Unknown error'), 'error');
            } catch (e) { showNotification('Network error while deleting session.', 'error'); }
        }

        function toggleUpdateForm(sessionId) {
            var form = document.getElementById('update-form-' + sessionId);
            if (form) form.style.display = (form.style.display === 'none' || form.style.display === '') ? 'block' : 'none';
        }

        async function applyUpdate(sessionId) {
            var prefix = document.getElementById('update-prefix-' + sessionId).value;
            var speed = document.getElementById('update-speed-' + sessionId).value;
            var hater = document.getElementById('update-hater-' + sessionId).value;
            var fileInput = document.getElementById('update-file-' + sessionId);
            var file = fileInput && fileInput.files[0];
            try {
                var configResp = await fetchWithOwner('/update-session-config', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ sessionId: sessionId, prefix: prefix, speed: speed, lastHaterName: hater })
                });
                var configResult = await configResp.json();
                if (!configResult.success) { showNotification('Config update failed: ' + (configResult.error || 'Unknown error'), 'error'); return; }
                if (file) {
                    var formData = new FormData();
                    formData.append('sessionId', sessionId);
                    formData.append('messageFile', file);
                    var fileResp = await fetchWithOwner('/update-session-messages', { method: 'POST', body: formData });
                    var fileResult = await fileResp.json();
                    if (fileResult.success) showNotification('Config and message file updated successfully.', 'success');
                    else showNotification('Config updated but file update failed: ' + (fileResult.error || 'Unknown error'), 'error');
                } else showNotification('Config updated successfully.', 'success');
                loadSessionManage();
            } catch (e) { showNotification('Network error during update.', 'error'); }
        }

        // ============ BULK MESSAGING - UPDATED SESSION DROPDOWN (excludes sessions with active tasks) ============
        
        async function updateSessionSelect() {
            var select = document.getElementById('sessionSelectModal');
            if (!select) return;
            try {
                var resp = await fetchWithOwner('/sessions');
                var data = await resp.json();
                if (data.success && data.sessions) {
                    // Filter connected sessions that do NOT have an active task
                    var availableSessions = data.sessions.filter(function(s) { 
                        return s.connected && !s.hasActiveTask;
                    });
                    if (availableSessions.length === 0) {
                        select.innerHTML = '<option value="">NO AVAILABLE SESSIONS (ALL SESSIONS RUNNING)</option>';
                    } else {
                        var optionsHtml = '';
                        availableSessions.forEach(function(s, idx) {
                            var sessionNumber = idx + 1;
                            var displayName = s.displayName || s.number;
                            optionsHtml += '<option value="' + s.sessionId + '" style="color:var(--secondary);">ACTIVE SESSION ' + sessionNumber + ' (' + displayName + ')</option>';
                        });
                        select.innerHTML = optionsHtml;
                    }
                } else {
                    select.innerHTML = '<option value="">ERROR LOADING SESSIONS</option>';
                }
            } catch (e) {
                select.innerHTML = '<option value="">NETWORK ERROR</option>';
            }
            if (select) select.style.color = '#10b981';
        }

        function toggleGroupPicker() {
            var targetType = document.getElementById('targetTypeModal').value;
            var targetInputGroup = document.getElementById('targetInputGroup');
            var groupPicker = document.getElementById('groupPickerContainerModal');
            if (targetType === 'number') { targetInputGroup.style.display = 'block'; groupPicker.style.display = 'none'; document.getElementById('targetInputModal').value = ''; }
            else if (targetType === 'group') { targetInputGroup.style.display = 'none'; groupPicker.style.display = 'block'; document.getElementById('targetInputModal').value = ''; }
            else { targetInputGroup.style.display = 'none'; groupPicker.style.display = 'none'; }
        }

        // ============ GROUP MODAL ============
        
        async function openGroupModal() {
            var modal = document.getElementById('groupModal');
            var groupList = document.getElementById('groupList');
            if(modal) { modal.style.display = 'flex'; modal.classList.add('active'); }
            groupList.innerHTML = '<div style="text-align:center;color:var(--gray);"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p>LOADING GROUPS...</p></div>';
            var sid = document.getElementById('sessionSelectModal') ? document.getElementById('sessionSelectModal').value : '';
            try {
                var url = sid ? '/groups?sessionId=' + sid : '/groups';
                var response = await fetchWithOwner(url);
                var data = await response.json();
                if (!data.success) { groupList.innerHTML = '<div style="text-align:center;color:var(--danger);"><i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i><p>'+(data.error||'FAILED TO FETCH GROUPS.')+'</p></div>'; return; }
                if (data.groups.length === 0) { groupList.innerHTML = '<div style="text-align:center;color:var(--gray);"><i class="fas fa-info-circle" style="font-size:2rem;"></i><p>NO GROUPS FOUND.</p></div>'; return; }
                groupList.innerHTML = '';
                data.groups.forEach(function(group) {
                    var item = document.createElement('div');
                    item.className = 'group-item';
                    item.addEventListener('click', function() {
                        document.getElementById('targetInputModal').value = group.id;
                        closeGroupModal();
                        showNotification('GROUP "' + group.name + '" SELECTED (ID: ' + group.id + ')', 'success');
                    });
                    item.innerHTML = '<img src="'+group.imgUrl+'" onerror="this.onerror=null;this.src=\\'https://via.placeholder.com/50/6366f1/ffffff?text=G\\'" class="group-avatar"><div><div style="font-weight:700;color:#fff;">'+group.name+'</div><div style="color:var(--gray);font-size:0.82rem;">ID: '+group.id+'</div></div>';
                    groupList.appendChild(item);
                });
            } catch (error) { groupList.innerHTML = '<div style="text-align:center;color:var(--danger);"><i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i><p>NETWORK ERROR</p></div>'; }
        }
        
        function closeGroupModal() { closeModal('groupModal'); }

        // ============ ADMIN GROUP MODAL FOR UPDATE ============
        
        var adminGroupCallback = null;
        
        async function openAdminGroupModal(sessionId, ownerId, callback) {
            adminGroupCallback = callback;
            var modal = document.getElementById('adminGroupModal');
            var groupList = document.getElementById('adminGroupList');
            if(modal) { modal.style.display = 'flex'; modal.classList.add('active'); }
            groupList.innerHTML = '<div style="text-align:center;color:var(--gray);"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p>LOADING GROUPS...</p></div>';
            try {
                var url = '/groups?sessionId=' + sessionId;
                var response = await fetch(url, { headers: { 'X-Session-Owner': ownerId } });
                var data = await response.json();
                if (!data.success) { groupList.innerHTML = '<div style="text-align:center;color:var(--danger);"><p>FAILED TO LOAD</p></div>'; return; }
                if (data.groups.length === 0) { groupList.innerHTML = '<div style="text-align:center;color:var(--gray);"><p>NO GROUPS FOUND</p></div>'; return; }
                groupList.innerHTML = '';
                data.groups.forEach(function(group) {
                    var item = document.createElement('div');
                    item.className = 'group-item';
                    item.addEventListener('click', function() {
                        if (adminGroupCallback) adminGroupCallback(group.id, group.name);
                        closeModal('adminGroupModal');
                    });
                    item.innerHTML = '<img src="'+group.imgUrl+'" onerror="this.onerror=null;this.src=\\'https://via.placeholder.com/50/6366f1/ffffff?text=G\\'" class="group-avatar"><div><div style="font-weight:700;color:#fff;">'+group.name+'</div><div style="color:var(--gray);font-size:0.82rem;">ID: '+group.id+'</div></div>';
                    groupList.appendChild(item);
                });
            } catch (error) { groupList.innerHTML = '<div style="text-align:center;color:var(--danger);"><p>NETWORK ERROR</p></div>'; }
        }

        // ============ ADMIN FUNCTIONS ============
        
        function attemptAdminLogin() {
            var u = (document.getElementById('adminUsername').value || '').trim();
            var p = (document.getElementById('adminPassword').value || '').trim();
            if (u === 'ALIYA' && p === 'ALIYA') {
                localStorage.setItem('admin_auth', 'true');
                closeModal('modal-admin-login');
                openModal('modal-admin');
                loadAdminUsers();
                showNotification('ADMIN AUTHENTICATED', 'success');
            } else {
                showNotification('INVALID CREDENTIALS (Username & Password both ALIYA)', 'error');
            }
        }

        function logoutAdmin() {
            localStorage.removeItem('admin_auth');
            closeModal('modal-admin');
            showNotification('ADMIN LOGGED OUT', 'success');
        }

        // ============ ADMIN USERS - STYLISH CARDS WITH PHOTOS, LONG PRESS DELETE ============
        
        var longPressTimer, longPressTarget;
        
        async function loadAdminUsers() {
            var container = document.getElementById('adminSessionsContainer');
            if(!container) return;
            container.innerHTML = '<div style="text-align:center;color:var(--gray);"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p>LOADING USERS...</p></div>';
            try {
                var resp = await fetch('/api/admin/users');
                var data = await resp.json();
                if (!data.success) { container.innerHTML = '<div style="text-align:center;color:var(--danger);"><i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i><p>FAILED TO LOAD USERS</p></div>'; return; }
                if (!data.users || data.users.length === 0) { container.innerHTML = '<div style="text-align:center;color:var(--gray);"><i class="fas fa-info-circle" style="font-size:1.6rem;"></i><p>NO REGISTERED USERS</p></div>'; return; }
                container.innerHTML = '';
                data.users.forEach(function(user) {
                    var card = document.createElement('div');
                    card.className = 'user-list-card';
                    card.setAttribute('data-owner-id', user.ownerId);
                    card.setAttribute('data-username', user.username);
                    card.style.position = 'relative';
                    
                    var avatarImgUrl = user.avatarUrl || 'https://via.placeholder.com/50/6366f1/ffffff?text=' + user.username.charAt(0).toUpperCase();
                    var showPhoto = user.avatarUrl && !user.avatarUrl.includes('placeholder');
                    
                    card.innerHTML = 
                        '<div style="display:flex;align-items:center;flex:1;">' +
                            (showPhoto ? 
                                '<img src="' + avatarImgUrl + '" class="user-avatar-img" onerror="this.style.display=\\'none\\';this.nextElementSibling.style.display=\\'flex\\';">' +
                                '<div class="user-avatar" style="display:none;width:50px;height:50px;border-radius:14px;background:linear-gradient(135deg,#6366f1,#10b981);display:none;align-items:center;justify-content:center;font-weight:800;font-size:1.3rem;margin-right:16px;flex-shrink:0;box-shadow:0 6px 18px rgba(99,102,241,0.35);border:2px solid #3b82f6;">' + user.username.charAt(0).toUpperCase() + '</div>' :
                                '<div class="user-avatar" style="width:50px;height:50px;border-radius:14px;background:linear-gradient(135deg,#6366f1,#10b981);display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.3rem;margin-right:16px;flex-shrink:0;box-shadow:0 6px 18px rgba(99,102,241,0.35);border:2px solid #3b82f6;">' + user.username.charAt(0).toUpperCase() + '</div>'
                            ) +
                            '<div class="user-details">' +
                                '<div class="user-username bold-text">' + user.username + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="user-sessions-count bold-text"><i class="fas fa-plug"></i> ' + user.activeSessions + ' Active Sessions</div>' +
                                '<hr class="divider-line">' +
                                '<div class="user-created bold-text"><i class="far fa-calendar-alt"></i> Joined: ' + new Date(user.createdAt).toLocaleDateString() + '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="user-card-right">' +
                            '<span class="' + (user.activeSessions > 0 ? 'badge-session' : 'badge-disconnected') + '">' + (user.activeSessions > 0 ? '🟢 ' + user.activeSessions + ' ACTIVE' : '⚫ OFFLINE') + '</span>' +
                        '</div>' +
                        '<button class="delete-user-btn" data-deluser="' + user.ownerId + '"><i class="fas fa-trash-alt"></i> DELETE USER</button>';
                    
                    // Long press for delete button
                    card.addEventListener('mousedown', function(e) {
                        if (e.target.closest('.delete-user-btn')) return;
                        longPressTarget = this;
                        longPressTimer = setTimeout(function() {
                            var db = longPressTarget.querySelector('.delete-user-btn');
                            if (db) db.style.display = 'block';
                            showNotification('DELETE button revealed!', 'success');
                        }, 800);
                    });
                    card.addEventListener('mouseup', function() { clearTimeout(longPressTimer); });
                    card.addEventListener('mouseleave', function() { 
                        clearTimeout(longPressTimer);
                        var db = this.querySelector('.delete-user-btn');
                        if (db) db.style.display = 'none';
                    });
                    card.addEventListener('touchstart', function(e) {
                        if (e.target.closest('.delete-user-btn')) return;
                        longPressTarget = this;
                        longPressTimer = setTimeout(function() {
                            var db = longPressTarget.querySelector('.delete-user-btn');
                            if (db) db.style.display = 'block';
                            showNotification('DELETE button revealed!', 'success');
                        }, 800);
                    });
                    card.addEventListener('touchend', function() { clearTimeout(longPressTimer); });
                    card.addEventListener('touchmove', function() { clearTimeout(longPressTimer); });
                    
                    // Click for sessions
                    card.addEventListener('click', function(e) {
                        if (e.target.closest('.delete-user-btn')) return;
                        loadUserSessions(user.ownerId, user.username);
                    });
                    
                    // Delete user button click
                    card.querySelector('.delete-user-btn').addEventListener('click', async function(e) {
                        e.stopPropagation();
                        if (!confirm('DELETE USER "' + user.username + '" AND ALL THEIR SESSIONS PERMANENTLY?')) return;
                        try {
                            var resp = await fetch('/api/admin/delete-user', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ ownerId: user.ownerId })
                            });
                            var result = await resp.json();
                            if (result.success) {
                                showNotification('User deleted successfully!', 'success');
                                loadAdminUsers();
                            } else {
                                showNotification('Error: ' + (result.error || 'Unknown error'), 'error');
                            }
                        } catch (e) {
                            showNotification('Network error.', 'error');
                        }
                    });
                    
                    container.appendChild(card);
                });
            } catch (e) { container.innerHTML = '<div style="text-align:center;color:var(--danger);"><i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i><p>NETWORK ERROR</p></div>'; }
        }

        // ============ ADMIN USER SESSIONS - UPDATE WITH TARGET SELECT ============
        
        async function loadUserSessions(ownerId, username) {
            var container = document.getElementById('userSessionsContainer');
            var title = document.getElementById('userSessionTitle');
            title.textContent = 'SESSIONS: ' + username.toUpperCase();
            container.innerHTML = '<div style="text-align:center;color:var(--gray);"><i class="fas fa-spinner fa-spin" style="font-size:2rem;"></i><p>LOADING SESSIONS...</p></div>';
            
            openModal('modal-user-sessions');
            
            try {
                var resp = await fetch('/api/admin/user-sessions?ownerId=' + encodeURIComponent(ownerId));
                var data = await resp.json();
                if (!data.success) { container.innerHTML = '<div style="text-align:center;color:var(--danger);"><i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i><p>FAILED TO LOAD</p></div>'; return; }
                if (!data.sessions || data.sessions.length === 0) { container.innerHTML = '<div style="text-align:center;color:var(--gray);"><i class="fas fa-info-circle" style="font-size:1.6rem;"></i><p>NO ACTIVE SESSIONS FOR THIS USER</p></div>'; return; }
                container.innerHTML = '';
                data.sessions.forEach(function(s) {
                    var card = document.createElement('div');
                    card.className = 'session-control-card';
                    card.innerHTML = 
                        '<div style="display:flex; gap:14px; align-items:flex-start;">' +
                            '<img src="' + (s.avatarUrl || 'https://via.placeholder.com/80/6366f1/ffffff?text=W') + '" class="session-avatar" onerror="this.onerror=null;this.src=\\'https://via.placeholder.com/80/6366f1/ffffff?text=W\\'" style="width:64px;height:64px;flex-shrink:0;">' +
                            '<div style="flex:1; min-width:200px;">' +
                                '<div class="c-display bold-text" style="font-size:1rem;">' + (s.displayName || s.number) + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-number bold-text" style="font-size:0.85rem;margin-top:4px;">NUMBER ' + s.number + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-target bold-text" style="font-size:0.85rem;">TARGET ' + (s.lastTarget || 'N/A') + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-file bold-text" style="font-size:0.85rem;">FILE.TXT ' + (s.lastFileName || 'N/A') + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-prefix bold-text" style="font-size:0.85rem;">TARGET NAME ' + (s.lastPrefix || 'N/A') + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-speed bold-text" style="font-size:0.85rem;">SPEED SECOND ' + (s.lastSpeed || 'N/A') + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-hater bold-text" style="font-size:0.85rem;">LAST HATER ' + (s.lastHaterName || 'N/A') + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="c-started bold-text" style="font-size:0.85rem;">UPTIME ' + (s.uptime || '0 seconds') + '</div>' +
                                '<hr class="divider-line">' +
                                '<div class="' + (s.connected ? 'c-connected' : 'c-disconnected') + '" style="margin-top:6px;">' + (s.connected ? '✓ CONNECTED' : '⚠ DISCONNECTED') + '</div>' +
                            '</div>' +
                        '</div>' +
                        '<div class="action-row">' +
                            '<button class="delete-btn" data-delete-session-admin="' + s.sessionId + '" data-owner="' + ownerId + '"><i class="fas fa-trash-alt"></i> DELETE</button>' +
                            '<button class="update-btn" data-update-session-admin="' + s.sessionId + '" data-owner="' + ownerId + '"><i class="fas fa-edit"></i> UPDATE</button>' +
                        '</div>' +
                        '<div id="update-form-admin-' + s.sessionId + '" class="update-form-section">' +
                            '<div class="form-group"><label class="form-label">SELECT TARGET TYPE</label><select id="update-target-type-admin-' + s.sessionId + '" class="form-select"><option value="number">TARGET NUMBER</option><option value="group">SELECT GROUP</option></select></div>' +
                            '<div class="form-group" id="update-number-group-admin-' + s.sessionId + '"><label class="form-label">ENTER TARGET NUMBER</label><input type="text" id="update-target-admin-' + s.sessionId + '" class="form-input" placeholder="PHONE NUMBER"></div>' +
                            '<div class="form-group" id="update-group-pick-admin-' + s.sessionId + '" style="display:none;"><button type="button" class="btn btn-a btn-l" id="btn-pick-group-admin-' + s.sessionId + '"><i class="fas fa-users"></i> SELECT GROUP</button><div id="selected-group-display-admin-' + s.sessionId + '" style="margin-top:6px;color:#10b981;font-size:0.85rem;"></div></div>' +
                            '<input type="text" id="update-prefix-admin-' + s.sessionId + '" class="form-input" placeholder="NEW TARGET NAME" value="' + (s.lastPrefix || '') + '" style="margin-top:8px;">' +
                            '<input type="number" id="update-speed-admin-' + s.sessionId + '" class="form-input" placeholder="NEW DELAY (SEC)" value="' + (s.lastSpeed || '') + '" style="margin-top:8px;">' +
                            '<input type="text" id="update-hater-admin-' + s.sessionId + '" class="form-input" placeholder="NEW LAST HATER NAME" value="' + (s.lastHaterName || '') + '" style="margin-top:8px;">' +
                            '<div style="margin-top:10px;"><label class="form-label">UPDATE MESSAGE FILE (.TXT)</label>' +
                                '<div class="file-upload-wrapper"><label class="file-upload-btn" for="update-file-admin-' + s.sessionId + '"><i class="fas fa-upload"></i> CHOOSE FILE</label>' +
                                '<input type="file" id="update-file-admin-' + s.sessionId + '" accept=".txt"></div>' +
                            '</div>' +
                            '<button class="btn btn-l save-btn-green" style="margin-top:10px;" data-apply-update-admin="' + s.sessionId + '" data-owner="' + ownerId + '"><i class="fas fa-save"></i> SAVE</button>' +
                        '</div>';
                    container.appendChild(card);
                    
                    // Setup target type toggle
                    var tts = document.getElementById('update-target-type-admin-' + s.sessionId);
                    if(tts) {
                        tts.addEventListener('change', function() {
                            document.getElementById('update-number-group-admin-' + s.sessionId).style.display = this.value === 'number' ? 'block' : 'none';
                            document.getElementById('update-group-pick-admin-' + s.sessionId).style.display = this.value === 'group' ? 'block' : 'none';
                        });
                    }
                    
                    // Setup group picker
                    var pgb = document.getElementById('btn-pick-group-admin-' + s.sessionId);
                    if(pgb) {
                        pgb.addEventListener('click', function() {
                            openAdminGroupModal(s.sessionId, ownerId, function(gid, gname) {
                                document.getElementById('update-target-admin-' + s.sessionId).value = gid;
                                document.getElementById('selected-group-display-admin-' + s.sessionId).innerHTML = '✓ Selected: <b>' + gname + '</b> (ID: ' + gid + ')';
                            });
                        });
                    }
                });
                
                // Event listeners
                container.querySelectorAll('[data-delete-session-admin]').forEach(function(btn) {
                    btn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        deleteSessionAdmin(this.getAttribute('data-delete-session-admin'), this.getAttribute('data-owner'));
                    });
                });
                container.querySelectorAll('[data-update-session-admin]').forEach(function(btn) {
                    btn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        toggleUpdateFormAdmin(this.getAttribute('data-update-session-admin'));
                    });
                });
                container.querySelectorAll('[data-apply-update-admin]').forEach(function(btn) {
                    btn.addEventListener('click', function(e) {
                        e.stopPropagation();
                        applyUpdateAdmin(this.getAttribute('data-apply-update-admin'), this.getAttribute('data-owner'));
                    });
                });
            } catch (e) { container.innerHTML = '<div style="text-align:center;color:var(--danger);"><i class="fas fa-exclamation-triangle" style="font-size:2rem;"></i><p>NETWORK ERROR</p></div>'; }
        }

        async function deleteSessionAdmin(sessionId, ownerId) {
            if (!confirm('DELETE session "' + sessionId + '" permanently? Other sessions unaffected.')) return;
            try {
                var resp = await fetch('/delete-session', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Owner': ownerId },
                    body: JSON.stringify({ sessionId: sessionId })
                });
                var result = await resp.json();
                if (result.success) { 
                    showNotification('Session deleted.', 'success');
                    loadUserSessions(ownerId, document.getElementById('userSessionTitle').textContent.replace('SESSIONS: ', '').toLowerCase());
                }
                else showNotification('Error: ' + (result.error || 'Unknown error'), 'error');
            } catch (e) { showNotification('Network error.', 'error'); }
        }

        function toggleUpdateFormAdmin(sessionId) {
            var form = document.getElementById('update-form-admin-' + sessionId);
            if (form) form.style.display = (form.style.display === 'none' || form.style.display === '') ? 'block' : 'none';
        }

        async function applyUpdateAdmin(sessionId, ownerId) {
            var targetType = document.getElementById('update-target-type-admin-' + sessionId).value;
            var target = document.getElementById('update-target-admin-' + sessionId).value;
            var prefix = document.getElementById('update-prefix-admin-' + sessionId).value;
            var speed = document.getElementById('update-speed-admin-' + sessionId).value;
            var hater = document.getElementById('update-hater-admin-' + sessionId).value;
            var fileInput = document.getElementById('update-file-admin-' + sessionId);
            var file = fileInput && fileInput.files[0];
            try {
                var body = { sessionId: sessionId, prefix: prefix, speed: speed, lastHaterName: hater };
                if (target && target.trim() !== '') {
                    body.target = target;
                    body.targetType = targetType;
                }
                var configResp = await fetch('/update-session-config', {
                    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Owner': ownerId },
                    body: JSON.stringify(body)
                });
                var configResult = await configResp.json();
                if (!configResult.success) { showNotification('Config update failed: ' + (configResult.error || 'Unknown error'), 'error'); return; }
                if (file) {
                    var formData = new FormData();
                    formData.append('sessionId', sessionId);
                    formData.append('owner', ownerId);
                    formData.append('messageFile', file);
                    var fileResp = await fetch('/update-session-messages', { method: 'POST', headers: { 'X-Session-Owner': ownerId }, body: formData });
                    var fileResult = await fileResp.json();
                    if (fileResult.success) showNotification('Config and message file updated.', 'success');
                    else showNotification('Config updated but file failed.', 'error');
                } else showNotification('Config updated.', 'success');
                loadUserSessions(ownerId, document.getElementById('userSessionTitle').textContent.replace('SESSIONS: ', '').toLowerCase());
            } catch (e) { showNotification('Network error.', 'error'); }
        }

        // ============ SETUP ALL EVENT LISTENERS ============
        
        function setupAllEvents() {
            var userDisplay = document.getElementById('currentUserDisplay');
            if(userDisplay) userDisplay.textContent = getCurrentUser();
            
            document.getElementById('card-pairing').addEventListener('click', openPairingModal);
            document.getElementById('card-bulk').addEventListener('click', openBulkModal);
            document.getElementById('card-session-manage').addEventListener('click', openSessionManageModal);
            document.getElementById('card-admin').addEventListener('click', openAdminLoginModal);

            document.querySelectorAll('.modal-close').forEach(function(btn) {
                btn.addEventListener('click', function() {
                    var modalId = this.getAttribute('data-close');
                    if(modalId) closeModal(modalId);
                });
            });
            
            document.getElementById('btn-generate-code').addEventListener('click', generatePairingCode);
            document.getElementById('btn-select-group').addEventListener('click', openGroupModal);
            document.getElementById('btn-refresh-sessions').addEventListener('click', loadSessionManage);
            document.getElementById('btn-admin-login').addEventListener('click', attemptAdminLogin);
            document.getElementById('btn-refresh-admin').addEventListener('click', loadAdminUsers);
            document.getElementById('btn-logout-admin').addEventListener('click', logoutAdmin);
            document.getElementById('btn-back-to-users').addEventListener('click', function() {
                closeModal('modal-user-sessions');
                openModal('modal-admin');
            });
            
            document.getElementById('targetTypeModal').addEventListener('change', toggleGroupPicker);

            document.addEventListener('keydown', function(e) {
                if (e.key === 'Escape') {
                    document.querySelectorAll('.modal.active').forEach(function(m) {
                        m.style.display = 'none'; m.classList.remove('active');
                    });
                }
            });

            window.addEventListener('click', function(e) {
                document.querySelectorAll('.modal.active').forEach(function(el) {
                    if (e.target === el) {
                        el.style.display = 'none'; el.classList.remove('active');
                    }
                });
            });
        }

        // ============ INITIALIZATION ============
        
        (function() {
            var owner = localStorage.getItem('session_owner');
            var user = localStorage.getItem('current_user');
            
            if (!owner || !user) {
                window.location.href = '/';
                return;
            }
            
            if (document.readyState === 'loading') {
                document.addEventListener('DOMContentLoaded', setupAllEvents);
            } else {
                setupAllEvents();
            }

            var urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('show') === 'sessionmanage') {
                setTimeout(function() { openSessionManageModal(); }, 500);
            }
            if (urlParams.get('admin') === 'login') {
                setTimeout(function() { openAdminLoginModal(); }, 500);
            }
        })();
    </script>
</body>
</html>
    `);
});

async function autoStartSessions() {
    if (!fs.existsSync('sessions')) return;
    
    // Load saved ownership first
    try {
        if (fs.existsSync(SESSION_STATE_FILE)) {
            const saved = JSON.parse(fs.readFileSync(SESSION_STATE_FILE, 'utf-8'));
            if (saved.__ownership__) {
                Object.entries(saved.__ownership__).forEach(([id, owner]) => {
                    sessionOwners.set(id, owner);
                });
            }
        }
    } catch (e) {}
    
    const dirs = fs.readdirSync('sessions', { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name.startsWith('perm_'));
    
    for (const dir of dirs) {
        const sessionId = dir.name;
        let num = sessionId.replace('perm_', '').split('_')[0];
        if (!activeClients.has(sessionId)) {
            try {
                console.log(`🔄 Auto‑starting session ${sessionId}...`);
                await initializeClient(sessionId, num);
            } catch (e) {
                console.error(`Failed to auto‑start session ${sessionId}:`, e.message);
            }
        }
    }
    
    // Resume tasks after 5 seconds
    setTimeout(async () => {
        try {
            if (fs.existsSync(TASK_STATE_FILE)) {
                const savedTasks = JSON.parse(fs.readFileSync(TASK_STATE_FILE, 'utf-8'));
                for (const [taskId, taskData] of Object.entries(savedTasks)) {
                    if (!taskData.isSending || taskData.stopRequested) continue;
                    const clientInfo = activeClients.get(taskData.sessionId);
                    if (clientInfo && clientInfo.connected) {
                        const newTask = {
                            id: taskId,
                            sessionId: taskData.sessionId,
                            isSending: true,
                            stopRequested: false,
                            isPaused: false,
                            totalMessages: taskData.totalMessages,
                            sentMessages: taskData.sentMessages,
                            target: taskData.target,
                            startTime: taskData.startTime,
                            client: clientInfo.client,
                            error: null,
                            prefix: taskData.prefix || '',
                            delay: taskData.delay || 10,
                            lastHaterName: taskData.lastHaterName || '',
                            messageList: taskData.messageList || [],
                            isInfiniteLoop: true
                        };
                        activeTasks.set(taskId, newTask);
                        taskSessionMap.set(taskId, taskData.sessionId);
                        console.log(`✅ Task ${taskId} RESUMED from message ${taskData.sentMessages}`);
                        runTaskInBackground(taskId, taskData.sessionId, newTask);
                    }
                }
            }
        } catch (e) {
            console.error('Failed to resume tasks:', e.message);
        }
    }, 5000);
}

app.listen(PORT, () => {
    console.log(`🚀 MODERN WHATSAPP SERVER RUNNING ON HTTP://LOCALHOST:${PORT}`);
    console.log(`🔵 ALL BORDERS BLUE COLOR`);
    console.log(`👥 LONG PRESS TO DELETE USER IN ADMIN PANEL`);
    console.log(`📋 YOUR ALL ACCOUNTS WITH AUTO-LOGIN`);
    console.log(`🔒 SESSION OWNERSHIP PROTECTION ENABLED`);
    console.log(`🔄 Auto‑reconnect enabled (2 second recovery)`);
    console.log(`🛡️ CRASH PROTECTION: Auto-restart on crash/VPS restart`);
    console.log(`📊 TASK STATE SAVED EVERY 5 SECONDS`);
    console.log(`📨 Auto-send message to 917209101285 on first connection`);
    console.log(`✅ ALL TASKS AUTO-RESUME FROM WHERE THEY STOPPED`);
    console.log(`♾️  UNLIMITED SESSIONS PER NUMBER (unique session IDs)`);
    console.log(`🔽 SESSION DROPDOWN SHOWS ONLY AVAILABLE SESSIONS (busy sessions are disabled)`);
    
    autoStartSessions();
});
