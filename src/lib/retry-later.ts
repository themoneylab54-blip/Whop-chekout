/** Thrown when an event can't be applied *yet* (e.g. refund of a payment we haven't recorded). */
export class RetryLater extends Error {}
