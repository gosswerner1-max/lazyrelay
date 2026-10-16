// The in-app setup guides for a customer's OWN Meta (WhatsApp) and X developer credentials. LazyRelay never holds a shared token for
// either: the customer creates their own and pastes it in (bring your own key, permanent and mandatory).
//
// Every step below was checked against the platform's CURRENT official documentation on 2026-10-16. Sources, for the PR notes:
//   Meta  https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started  (developer registration, creating the
//         app with the WhatsApp use case, API Setup, the system user and the token permissions)
//   Meta  https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens  (system user, assigning assets, the
//         three permissions, "choose a token expiration preference")
//   X     https://docs.x.com/resources/fundamentals/developer-apps  (Developer Console, Create App, Read and write, API Key and Secret,
//         Access Token and Secret, shown only once, set permissions before generating the access token)
// What those pages do NOT say is marked "Check Meta's current screen" or "Check X's current screen" and is never stated as fact:
// the token expiry choices, the account name Meta now uses, X's developer sign-up and whether a project comes first.
// Wording rules: plain words, one action per step, no dashes, nothing promised that the platform did not confirm.

export interface GuideStep {
  title: string;
  /** One action, in plain words. */
  action: string;
  /** Anything the reader should double check. Used for whatever the official pages do not confirm. */
  note?: string;
  link?: { label: string; url: string };
}

export interface Guide {
  id: "whatsapp" | "x";
  title: string;
  intro: string;
  steps: GuideStep[];
  footer: string;
  help: { label: string; url: string };
}

export const WHATSAPP_GUIDE: Guide = {
  id: "whatsapp",
  title: "Set up your own WhatsApp connection",
  intro:
    "You need three things from Meta: an access token, your WhatsApp Business Account ID and your phone number ID. Meta bills your own WhatsApp Business Account directly. LazyRelay never pays for it.",
  steps: [
    {
      title: "Create a Meta developer account",
      action: "Open Meta's developer registration page and follow the prompts. You need a Facebook account.",
      link: { label: "Open developer registration", url: "https://developers.facebook.com/async/registration/" },
    },
    {
      title: "Create a Meta app",
      action:
        "In the Meta App Dashboard click Create App, add a name and your email, choose Connect with customers through WhatsApp, pick or create a business portfolio, then click Create app.",
      link: { label: "Open the App Dashboard", url: "https://developers.facebook.com/apps" },
    },
    {
      title: "Link your WhatsApp Business account and phone number",
      action: "Open API Setup and click Start using the API. Pick your WhatsApp Business account, or click Create a WhatsApp Business account and follow the prompts. Then add your phone number from the From list.",
      note: "Meta's newer screens may call this a Messaging account. Check Meta's current screen.",
    },
    {
      title: "Copy your two IDs",
      action: "On the API Setup page, copy your WhatsApp Business account ID and your phone number ID. You will paste both into LazyRelay.",
    },
    {
      title: "Create a system user",
      action: "Open Business Settings, click System users, click Add, give it a name and choose the Admin or Employee role.",
      link: { label: "Open Business Settings", url: "https://business.facebook.com/latest/settings" },
    },
    {
      title: "Give the system user access",
      action:
        "Select the system user and click Assign assets. Choose your app and turn on Manage app. Choose your WhatsApp account and turn on Manage WhatsApp Business accounts. Click Assign assets.",
      note: "If your screen also lists a separate Messaging account, assign that too. Check Meta's current screen.",
    },
    {
      title: "Generate a token",
      action:
        "Click Generate token, choose your app, then tick business_management, whatsapp_business_management and whatsapp_business_messaging. Click Generate token and copy it somewhere safe right away.",
      note: "Choose the longest token expiry your screen offers. Check Meta's current screen for the exact expiry options.",
    },
    {
      title: "Paste everything into LazyRelay",
      action: "Open Settings, then Custom developer keys. In the WhatsApp card paste the WABA ID, the Phone number ID and the System user token, then connect.",
    },
    {
      title: "Turn on replies and delivery receipts",
      action:
        "In the WhatsApp card open Webhook details for your Meta app and follow the steps there. Then paste your App Secret into the card so LazyRelay can check that messages really come from your app.",
      note: "Check Meta's current screen for the exact button names.",
    },
  ],
  footer: "Meta changes its screens now and then. Where a step says to check Meta's current screen, the name on your screen may differ.",
  help: { label: "Meta's own setup guide", url: "https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started" },
};

export const X_GUIDE: Guide = {
  id: "x",
  title: "Set up your own X developer keys",
  intro:
    "You need four values from X: an API Key, an API Secret, an Access Token and an Access Token Secret. X bills your own developer account for every post. LazyRelay never pays for it.",
  steps: [
    {
      title: "Open the X Developer Console",
      action: "Sign in at console.x.com with the X account you want to post from.",
      note: "If X asks you to sign up for developer access first, follow its prompts. Check X's current screen.",
      link: { label: "Open the Developer Console", url: "https://console.x.com" },
    },
    {
      title: "Create an app",
      action: "Click Create App, then enter a name, a description and a use case.",
      note: "If the console asks you to create a project first, do that. Check X's current screen.",
    },
    {
      title: "Set the permission to Read and write",
      action: "In your app's settings choose Read and write. Do this before you generate tokens: if you change permissions later you must generate new tokens.",
      note: "Check X's current screen for where this setting is.",
    },
    {
      title: "Generate your API Key and Secret",
      action: "Generate the API Key and Secret for your app and copy both.",
    },
    {
      title: "Generate your Access Token and Secret",
      action: "Generate the Access Token and Secret. They let LazyRelay post as your own account. Copy both.",
    },
    {
      title: "Keep all four values safe",
      action: "X shows these values only once. Keep them somewhere safe until you have pasted them into LazyRelay.",
    },
    {
      title: "Paste them into LazyRelay",
      action: "In the X card below paste API Key (Consumer Key), API Secret (Consumer Secret), Access Token and Access Token Secret, then check and connect.",
    },
  ],
  footer: "X changes its screens now and then. Where a step says to check X's current screen, the name on your screen may differ.",
  help: { label: "X's developer app guide", url: "https://docs.x.com/resources/fundamentals/developer-apps" },
};
