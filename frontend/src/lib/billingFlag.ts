// The one switch for the credit-wallet billing screens. Build-time and exact: anything except the word "true" is off, and
// with it off the production build carries none of the billing screens (they are loaded lazily behind this constant).
export const BILLING_ENABLED = import.meta.env.VITE_BILLING_ENABLED === "true";
