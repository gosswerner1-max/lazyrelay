const authentication = require("./authentication");

const newPostPublished = require("./triggers/newPostPublished");
const newMention = require("./triggers/newMention");
const listSocialAccounts = require("./triggers/listSocialAccounts");

const uploadMedia = require("./creates/uploadMedia");
const schedulePost = require("./creates/schedulePost");
const cancelPost = require("./creates/cancelPost");
const replyToMention = require("./creates/replyToMention");

const findSocialAccount = require("./searches/findSocialAccount");

const includeBearerToken = (request, z, bundle) => {
  if (bundle.authData.apiKey) {
    request.headers.Authorization = `Bearer ${bundle.authData.apiKey}`;
  }
  return request;
};

module.exports = {
  version: require("./package.json").version,
  platformVersion: require("zapier-platform-core").version,

  authentication,

  beforeRequest: [includeBearerToken],

  triggers: {
    [newPostPublished.key]: newPostPublished,
    [newMention.key]: newMention,
    [listSocialAccounts.key]: listSocialAccounts,
  },

  creates: {
    [uploadMedia.key]: uploadMedia,
    [schedulePost.key]: schedulePost,
    [cancelPost.key]: cancelPost,
    [replyToMention.key]: replyToMention,
  },

  searches: {
    [findSocialAccount.key]: findSocialAccount,
  },

  resources: {},
};
