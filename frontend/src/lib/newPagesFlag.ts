// The Midnight Canvas restyle (canvas #0b0f19, panels #141b2d, locked orange #ff5630) of the Login and Signup page. Read on every call, so a
// test can switch it. Off by default: with anything other than the string "true" the page renders exactly as before.
export const newPagesEnabled = (): boolean => import.meta.env.VITE_NEW_PAGES_ENABLED === "true";
