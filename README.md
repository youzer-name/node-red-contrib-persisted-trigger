# node-red-contrib-persisted-trigger

A drop-in replacement for Node-RED’s core **Trigger** node, extended with **persistence across restarts** and enhanced handling of expired timers.  
It provides the same configuration and behavior as the stock Trigger node, plus a few extra options.

---

## Why use this node?

The core **Trigger** node loses all pending timers and messages whenever Node-RED restarts.  
This node stores its state in the selected [context store](https://nodered.org/docs/user-guide/context) (e.g. `localfilesystem`) so that:

- Pending timers survive a Node-RED restart or redeploy.
- Messages scheduled to fire *after* a restart will still be delivered at their original expiry time (or flagged if already expired).
- You control where state is stored via a **Context store** dropdown.

---

## Key differences from the stock Trigger node

### 1. Persistence
- Uses Node-RED context storage to remember pending timers.
- When restarted:
  - If a timer is still in the future, the message will be delivered at the correct time.
  - If a timer has already expired during downtime, behavior is controlled by the **Expired handling** option.

### 2. Expired handling
When a message’s timer expires while Node-RED is offline, you can choose:

- **Discard** – Drop the expired message (default, like stock Trigger).
- **Send anyway** – Deliver the message immediately on restart.
- **Flag and send** – Deliver the message and add:
  - `msg.expired = true`
  - `msg.triggerOriginalExpiry = <unix timestamp>`  
  Downstream nodes can decide whether to keep or discard it.

### 3. Context store selection
- New **Context store** dropdown lets you pick from configured stores (`memory`, `localfilesystem`, or custom).
- Useful if you want persistence only in some flows, or different retention behaviors.

### 4. Separate outputs
- Option: **Send second message to separate output**  
  When enabled, the node has 2 outputs:
  - **Output 1** → First message ("send now")
  - **Output 2** → Second message ("then send")  
- Note: In **Resend every** or **Wait until reset** mode, the second output is disabled (matches stock Trigger behavior).

---

## Node status

The node updates its status text so you can see what’s happening at a glance:

- **Idle** – No pending messages.
- **1 pending / 2 pending / ...** – How many timers are active (in *all messages* mode).
- **reset** – A reset message was received and cleared the timer.
- **expired** – A persisted message expired during downtime and was discarded/flagged/sent depending on settings.

---

## Other features preserved from stock Trigger

- **Override delay with `msg.delay`** – Replace the configured duration dynamically.
- **Extend delay if new message arrives** – Restart the timer if more messages arrive.
- **Handling modes**:
  - *All messages* – One timer for the whole node.
  - *Each msg property* – Independent timers per `msg.topic` (or another message property).
- **Typed input selectors** for both *Send* and *Then send*:
  - existing/original message object
  - latest message
  - string, number, boolean, JSON, buffer, timestamp
  - env variable, flow context, global context
  - nothing

---

## Example use cases

- **Reliable watchdog timers** – A reset message can stop the output, even if Node-RED restarts in between.
- **Delayed alerts** – Schedule notifications to fire later, without losing them on reboot.
- **Persistence testing** – Try with long timers, restart Node-RED mid-way, and confirm outputs still happen.

---

## Installation

```bash
npm install node-red-contrib-persisted-trigger
```

## Compatibility

Tested with Node-RED 4.x.

Requires at least one persistent context store configured (e.g. localfilesystem) if you want timers to survive restarts.


## Limitations

Certain msg parts are not serializable and cause a circular reference error.  Those parts are stripped from the persisted message.  
That includes msg.req, msg.res, and msg.socket.  When persisting the output of nodes (like HTTP in) that contain these parts, the original message object will contain them, but if the user selects either 'original message object' or 'latest message' under 'then send', the message sent at the end of the timer will NOT contain those message parts.
