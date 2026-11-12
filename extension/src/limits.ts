/** A page's request, as JSON, at most this long: checked by the content script before it
 *  sends, and by the worker again on arrival. */
export const MAX_REQUEST = 1_000_000;
