// Messages between the page and the service worker. scripts/sw-template.js repeats these strings (a plain script cannot import them);
// tests/unit/sw-routing.test.ts keeps both in step.
export const SW_MESSAGE_SKIP_WAITING = "SKIP_WAITING";
export const SW_MESSAGE_GET_STATUS = "GET_STATUS";
export const SW_MESSAGE_STATUS = "STATUS";
export const SW_MESSAGE_SHELL_READY = "SHELL_READY";
