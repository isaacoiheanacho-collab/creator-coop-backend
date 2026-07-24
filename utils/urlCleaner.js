// utils/urlCleaner.js

/**
 * Comprehensive list of tracking parameters to remove from URLs
 * Sorted by platform for easy maintenance
 */
const TRACKING_PARAMS = [
  // Google Analytics / Universal Analytics
  'utm_source',
  'utm_medium', 
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_cid',
  'utm_reader',
  'utm_viz_id',
  'utm_pubreferrer',

  // Google Ads / Marketing
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'msclkid',
  'ref',
  'source',
  'si',
  's_kwcid',
  'trk',
  'trkCampaign',
  'CNDID',
  'cid',

  // Social Media Platforms
  'fbclid',     // Facebook
  'gclid',      // Google
  'msclkid',    // Microsoft/Bing
  'ref_src',    // Twitter/X
  't',          // Twitter/X
  's',          // Twitter/X
  'mc_cid',     // Mailchimp
  'mc_eid',     // Mailchimp
  'vero_conv',  // Vero
  'vero_id',    // Vero
  'pk_campaign', // Piwik/Matomo
  'pk_kwd',      // Piwik/Matomo
  'pk_source',   // Piwik/Matomo
  'pk_medium',   // Piwik/Matomo
  'pk_content',  // Piwik/Matomo

  // YouTube / Video Platforms
  'feature',
  'list',
  'index',
  'playnext',
  'start_radio',
  't',

  // General / Misc
  'source',
  'ref',
  'referrer',
  'origin',
  'redirect',
  'redirect_uri',
  'return',
  'return_to',
  'next',
  'redir',
  'url',
  'link',
  'from',
  'via',
  'campaign',
  'code',
  'token',
  'state',
  'session_id',
  'click_id',
  'clickid',
  'affiliate',
  'affid',
  'partner',
  'partner_id',
  'src',
  'cmp',
  'mkt',
  'adgroup',
  'placement',
  'device',
  'network',
  'creative',
  'keyword',
  'matchtype',
  'placement',
  'target',
  'audience',
  'channel',
  'placement',
  'subid',
  'sub1',
  'sub2',
  'sub3',
  'sub4',
  'sub5',
];

/**
 * Clean a URL by removing all tracking parameters
 * @param {string} url - The URL to clean
 * @param {Object} options - Configuration options
 * @param {boolean} options.keepRef - Keep 'ref' parameter if set to true
 * @param {Array<string>} options.additionalParams - Extra params to remove
 * @returns {string} - Cleaned URL
 */
function cleanUrl(url, options = {}) {
  // Return empty strings or null as-is
  if (!url || typeof url !== 'string') {
    return url;
  }

  // Trim whitespace
  url = url.trim();

  // If it's not a valid URL, return as-is
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch (e) {
    // Invalid URL - return original
    return url;
  }

  // Build list of params to remove
  let paramsToRemove = [...TRACKING_PARAMS];
  
  // If we want to keep ref parameter, remove it from the list
  if (options.keepRef) {
    paramsToRemove = paramsToRemove.filter(p => p !== 'ref');
  }

  // Add additional custom params
  if (options.additionalParams && Array.isArray(options.additionalParams)) {
    paramsToRemove = paramsToRemove.concat(options.additionalParams);
  }

  // Remove each tracking parameter
  paramsToRemove.forEach(param => {
    urlObj.searchParams.delete(param);
  });

  // Remove empty search params (the ? if no params left)
  const cleanUrl = urlObj.toString();
  
  // If the URL ended with ? and no params, remove the ?
  if (cleanUrl.endsWith('?')) {
    return cleanUrl.slice(0, -1);
  }

  return cleanUrl;
}

/**
 * Check if a URL contains tracking parameters
 * @param {string} url - The URL to check
 * @returns {boolean} - True if tracking parameters are found
 */
function hasTrackingParams(url) {
  if (!url) return false;
  
  try {
    const urlObj = new URL(url);
    const params = Array.from(urlObj.searchParams.keys());
    return params.some(param => TRACKING_PARAMS.includes(param));
  } catch (e) {
    return false;
  }
}

/**
 * Get the count of tracking parameters in a URL
 * @param {string} url - The URL to analyze
 * @returns {number} - Number of tracking parameters found
 */
function countTrackingParams(url) {
  if (!url) return 0;
  
  try {
    const urlObj = new URL(url);
    const params = Array.from(urlObj.searchParams.keys());
    return params.filter(param => TRACKING_PARAMS.includes(param)).length;
  } catch (e) {
    return 0;
  }
}

/**
 * Get all tracking parameters from a URL
 * @param {string} url - The URL to analyze
 * @returns {Object} - Object with tracking param keys and values
 */
function getTrackingParams(url) {
  if (!url) return {};
  
  try {
    const urlObj = new URL(url);
    const result = {};
    urlObj.searchParams.forEach((value, key) => {
      if (TRACKING_PARAMS.includes(key)) {
        result[key] = value;
      }
    });
    return result;
  } catch (e) {
    return {};
  }
}

module.exports = {
  cleanUrl,
  hasTrackingParams,
  countTrackingParams,
  getTrackingParams,
  TRACKING_PARAMS,
};