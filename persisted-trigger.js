module.exports = function(RED) {
    "use strict";

    function PersistedTriggerNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        // --- configuration from editor ---
        node.op1 = config.op1;
        node.op1type = config.op1type || "pay";
        node.op2 = config.op2;
        node.op2type = config.op2type || "nothing";
        node.duration = config.duration || 0;
        node.units = config.units || "s";
        node.extend = !!config.extend;
        node.overrideDelay = !!config.overrideDelay;
        node.mode = config.mode || "wait"; // "wait", "waitreset", "resend"
        node.resetVal = (config.reset !== undefined) ? config.reset : "";
        node.bymode = config.bymode || "all"; // "all" or "each"
        node.by = config.by || "topic";
        node.secondOutput = !!config.secondOutput;
        node.expired = config.expired || "discard"; // "discard" | "send" | "flag"
        node.store = config.store || undefined; // context store to use

        // store key unique per-node
        const STORE_KEY = "persisted-trigger:" + node.id;

        // --- persistent state (per-node) ---
        let pending = node.context().get(STORE_KEY, node.store) || {};

        // runtime timers: key -> { type: "timeout"|"interval", handle }
        let timers = {};

    //
    // New helper: clone and strip out properties that often cause circular references
    function makePersistableClone(m) {
        let clean;
        try {
            clean = RED.util.cloneMessage(m);
        } catch(err) {
            // fallback
            try {
                clean = JSON.parse(JSON.stringify(m));
            } catch(e) {
                clean = {};
            }
        }
        // Remove common problematic properties
        if (clean && typeof clean === "object") {
            delete clean.req;
            delete clean.res;
            delete clean.socket;
            // you may add more deletes here if other circular fields show up
        }
        return clean;
    }

        // --- helpers ---
        function msFromDuration(val, units) {
            const n = Number(val) || 0;
            switch ((units || "s")) {
                case "ms": return n;
                case "s": return n * 1000;
                case "min": return n * 60 * 1000;
                case "hr": return n * 3600 * 1000;
                case "day": return n * 24 * 3600 * 1000;
                default: return n * 1000;
            }
        }

        function persistPending() {
            try {
                node.context().set(STORE_KEY, pending, node.store);
            } catch (err) {
                node.warn("persisted-trigger: failed to persist pending: " + err);
            }
        }

        function updateStatus() {
            const count = Object.keys(pending).length;
            if (count === 0) {
                node.status({ fill: "grey", shape: "ring", text: "idle" });
            } else {
                node.status({ fill: "yellow", shape: "dot", text: `${count} pending` });
            }
        }

        function clearTimer(key) {
            const t = timers[key];
            if (t) {
                try {
                    if (t.type === "timeout") clearTimeout(t.handle);
                    else if (t.type === "interval") clearInterval(t.handle);
                } catch (err) {}
                delete timers[key];
            }
        }

        function clearEntry(key) {
            clearTimer(key);
            delete pending[key];
            persistPending();
            updateStatus();
        }

        function cloneMsgSafe(m) {
            try {
                return RED.util.cloneMessage(m);
            } catch (err) {
                try { return JSON.parse(JSON.stringify(m)); } catch(e) { return {}; }
            }
        }

        // Build message according to typed-input type/value
        function buildMessageForType(origMsg, latestMsg, type, value) {
            // origMsg and latestMsg are clones
            if (!type) type = "str";

            // message-object cases
            if (type === "pay" || type === "orig") {
                // return original message object (clone)
                return cloneMsgSafe(origMsg || latestMsg || {});
            }
            if (type === "payl") {
                return cloneMsgSafe(latestMsg || origMsg || {});
            }
            if (type === "nothing" || type === "nul") {
                return null;
            }

            // context/env
            if (type === "flow") {
                try { return { payload: node.context().flow.get(value) }; } catch (err) { return { payload: undefined }; }
            }
            if (type === "global") {
                try { return { payload: node.context().global.get(value) }; } catch (err) { return { payload: undefined }; }
            }
            if (type === "env") {
                return { payload: process.env[value] };
            }

            // date/timestamp
            if (type === "date") {
                if (!value || value === "") return { payload: Date.now() };
                if (value === "iso") return { payload: new Date().toISOString() };
                if (value === "date") return { payload: new Date() };
                const parsed = parseInt(value);
                return { payload: isNaN(parsed) ? Date.now() : parsed };
            }

            // json
            if (type === "json") {
                try { return { payload: JSON.parse(value) }; } catch (e) { return { payload: value }; }
            }

            // buffer
            if (type === "bin") {
                try { return { payload: Buffer.from(String(value), "utf8") }; } catch (e) { return { payload: undefined }; }
            }

            // boolean
            if (type === "bool") {
                const v = String(value).toLowerCase();
                return { payload: (v === "true" || v === "1") };
            }

            // number
            if (type === "num") {
                const n = Number(value);
                return { payload: isNaN(n) ? value : n };
            }

            // string fallback
            return { payload: value };
        }

        // send 'then' message for a key
        function sendThenForKey(key, options) {
            options = options || {};
            const entry = pending[key];
            if (!entry) return;

            // build then message based on op2 selection and orig/latest
            const thenMsg = buildMessageForType(entry.orig, entry.latest, node.op2type, node.op2);
            if (!thenMsg) {
                // nothing to send
                clearEntry(key);
                return;
            }

            // expired-on-restore: if flagged, set boolean and original expiry
            if (options.expiredOnRestore && node.expired === "flag") {
                try { thenMsg.expired = true; thenMsg.triggerOriginalExpiry = entry.expiry; } catch (err) {}
            }

            // do not allow secondOutput for 'resend' or 'waitreset' modes
            const allowSecond = node.secondOutput && entry.mode !== "resend" && entry.mode !== "waitreset";

            if (allowSecond) node.send([ null, thenMsg ]);
            else node.send([ thenMsg, null ]);

            clearEntry(key);
        }

        // schedule a wait (one-shot) for a key
        function scheduleWait(key, entry, delayMs) {
            clearTimer(key);
            entry.mode = "wait";
            entry.expiry = Date.now() + delayMs;
            pending[key] = entry;
            persistPending();

            timers[key] = {
                type: "timeout",
                handle: setTimeout(function() {
                    // on expiry send then
                    sendThenForKey(key, { expiredOnRestore: false });
                    clearTimer(key);
                    updateStatus();
                }, delayMs)
            };
            updateStatus();
        }

        // schedule a newly created resend
        function scheduleResendNew(key, entry, intervalMs) {
            clearTimer(key);
            entry.mode = "resend";
            entry.intervalMs = intervalMs;
            entry.lastSent = Date.now();
            pending[key] = entry;
            persistPending();

            // send immediate op1
            const first = buildMessageForType(entry.orig, entry.latest, node.op1type, node.op1);
            if (first) node.send([ first, null ]);

            // schedule repeating op1
            timers[key] = {
                type: "interval",
                handle: setInterval(function() {
                    const e = pending[key];
                    if (!e) return;
                    e.lastSent = Date.now();
                    persistPending();
                    const m = buildMessageForType(e.orig, e.latest, node.op1type, node.op1);
                    if (m) node.send([ m, null ]);
                }, intervalMs)
            };
            updateStatus();
        }

        // restore a resend entry from persistent store
        function scheduleResendRestore(key, entry) {
            // compute interval
            const intervalMs = entry.intervalMs || msFromDuration(node.duration, node.units);
            const now = Date.now();

            // determine initial delay:
            // if lastSent exists and nextTime > now => wait until nextTime,
            // otherwise start fresh after intervalMs (do not try to catch up missed sends).
            let initialDelay = intervalMs;
            if (entry.lastSent) {
                const nextTime = entry.lastSent + intervalMs;
                if (nextTime > now) initialDelay = nextTime - now;
                else initialDelay = intervalMs;
            }

            clearTimer(key);

            // schedule first tick after initialDelay, then switch to interval
            timers[key] = {
                type: "timeout",
                handle: setTimeout(function firstTick() {
                    const e = pending[key];
                    if (!e) return;
                    const m = buildMessageForType(e.orig, e.latest, node.op1type, node.op1);
                    if (m) node.send([ m, null ]);
                    e.lastSent = Date.now();
                    persistPending();

                    // now start regular interval
                    clearTimer(key);
                    timers[key] = {
                        type: "interval",
                        handle: setInterval(function() {
                            const ee = pending[key];
                            if (!ee) return;
                            ee.lastSent = Date.now();
                            persistPending();
                            const mm = buildMessageForType(ee.orig, ee.latest, node.op1type, node.op1);
                            if (mm) node.send([ mm, null ]);
                        }, intervalMs)
                    };
                    updateStatus();
                }, initialDelay)
            };
            updateStatus();
        }

        // --- restore pending entries on start ---
        (function restoreOnStart() {
            try {
                const now = Date.now();
                Object.keys(pending).forEach(function(key) {
                    const entry = pending[key];
                    if (!entry || !entry.mode) return;
                    if (entry.mode === "wait") {
                        // compute remaining time
                        const remaining = (entry.expiry || 0) - now;
                        if (remaining <= 0) {
                            // expired while down
                            if (node.expired === "send" || node.expired === "flag") {
                                const tm = buildMessageForType(entry.orig, entry.latest, node.op2type, node.op2);
                                if (tm) {
                                    if (node.expired === "flag") { try { tm.expired = true; tm.triggerOriginalExpiry = entry.expiry; } catch (e) {} }
                                    const allowSecond = node.secondOutput && entry.mode !== "resend" && entry.mode !== "waitreset";
                                    if (allowSecond) node.send([ null, tm ]); else node.send([ tm, null ]);
                                }
                            }
                            // remove one-shot expired
                            delete pending[key];
                        } else {
                            scheduleWait(key, entry, remaining);
                        }
                    } else if (entry.mode === "resend") {
                        scheduleResendRestore(key, entry);
                    } else if (entry.mode === "waitreset") {
                        // keep it stored, no timer active
                        pending[key] = entry;
                    }
                });
                persistPending();
                updateStatus();
            } catch (err) {
                node.warn("persisted-trigger: restore failed: " + err);
            }
        })();

        // --- input handling ---
        node.on("input", function(msg, send, done) {
            send = send || function() { node.send.apply(node, arguments); };

            // compute key
            let key = "__global__";
            if (node.bymode === "each") {
                try {
                    const v = RED.util.getMessageProperty(msg, node.by);
                    key = (v === undefined || v === null) ? "__undefined__" : String(v);
                } catch (err) {
                    key = "__undefined__";
                }
            }

            // detect reset message
            let isReset = false;
            if (msg && msg.reset) isReset = true;
            if (!isReset && node.resetVal !== undefined && node.resetVal !== null && String(node.resetVal) !== "") {
                try { if (String(msg.payload) === String(node.resetVal)) isReset = true; } catch (err) {}
            }

            if (isReset) {
                const e = pending[key];
                if (e) {
                    if (e.mode === "waitreset") {
                        // on reset, send then and clear
                        const thenMsg = buildMessageForType(e.orig, e.latest, node.op2type, node.op2);
                        if (thenMsg) {
                            // do not allow second output in waitreset
                            const allowSecond = false;
                            if (allowSecond) node.send([ null, thenMsg ]); else node.send([ thenMsg, null ]);
                        }
                        clearEntry(key);
                    } else {
                        // clear pending (suppress output)
                        clearEntry(key);
                    }
                }
                if (done) done();
                return;
            }

            // determine delay/interval ms:
            let delayMs = msFromDuration(node.duration, node.units);
            if (node.overrideDelay && msg && msg.hasOwnProperty("delay")) {
                // msg.delay is always in milliseconds (stock trigger behavior)
                const dd = Number(msg.delay);
                if (!isNaN(dd) && dd >= 0) delayMs = dd;
            }

            const existing = pending[key];

            if (node.mode === "wait") {
                if (!existing) {
                    // send op1 immediately to output1
                    const out1 = buildMessageForType(msg, msg, node.op1type, node.op1);
                    if (out1) node.send([ out1, null ]);

                    // create pending entry and schedule timeout
                    const entry = { mode: "wait", orig: makePersistableClone(msg), latest: makePersistableClone(msg) };
                    scheduleWait(key, entry, delayMs);
                } else {
                    // update latest; do NOT emit op1
                    existing.latest = makePersistableClone(msg);
                    // extend behaviour
                    if (node.extend) {
                        scheduleWait(key, existing, delayMs);
                    } else {
                        pending[key] = existing;
                        persistPending();
                        updateStatus();
                    }
                }
            }
            else if (node.mode === "waitreset") {
                if (!existing) {
                    // send op1 immediately to output1
                    const out1 = buildMessageForType(msg, msg, node.op1type, node.op1);
                    if (out1) node.send([ out1, null ]);
                    // store waiting for reset
	            pending[key] = { mode: "waitreset", orig: makePersistableClone(msg), latest: makePersistableClone(msg) };
                    persistPending();
                    updateStatus();
                } else {
                    // update latest, wait for reset
                    existing.latest = makePersistableClone(msg);
                    pending[key] = existing;
                    persistPending();
                    updateStatus();
                }
            }
            else if (node.mode === "resend") {
                // start fresh: clear any existing then create resend entry
                clearEntry(key);
                const entry = { mode: "resend", orig: makePersistableClone(msg), latest: makePersistableClone(msg), intervalMs: delayMs, lastSent: Date.now() };
                // schedule new resend
                scheduleResendNew(key, entry, delayMs);
            }

            if (done) done();
        });

        // on close: clear timers; if removed, delete persisted store
        node.on("close", function(removed, done) {
            Object.keys(timers).forEach(function(k) {
                try {
                    if (timers[k].type === "timeout") clearTimeout(timers[k].handle);
                    else if (timers[k].type === "interval") clearInterval(timers[k].handle);
                } catch (err) {}
            });
            timers = {};
            if (removed) {
                try { node.context().set(STORE_KEY, undefined, node.store); } catch (err) {}
                pending = {};
            } else {
                persistPending();
            }
            node.status({});
            if (done) done();
        });

        // initial status
        updateStatus();
    }

    RED.nodes.registerType("persisted-trigger", PersistedTriggerNode);
};
