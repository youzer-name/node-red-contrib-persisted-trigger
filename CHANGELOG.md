1.0.3 - 2025-09-19 - Add helper function to strip non-serializable message parts (msg.req, msg.res, msg.socket).  This fixes a circular reference error when trying to persist the output of a 'HTTP in' node.  Messages with .req, .res, or .socket will send those parts in the original message object, but they will be stripped from the persisted message and not included when in the final message sent when'then send' is either 'orignal message object' or 'latest message object'.

1.0.2 - 2025-09-18 - Fix typo in JS file
