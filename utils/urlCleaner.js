// utils/urlCleaner.js

/**
 * Clean a URL by removing common tracking parameters
 * @param {string} originalUrl - The URL to clean
 * @returns {string} - Cleaned URL
 */
function cleanUrl(originalUrl) {
  try {
    const url = new URL(originalUrl);
    
    // Remove common tracking parameters
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 
      'utm_term', 'utm_content', 'utm_id',
      'fbclid', 'mibextid', 'gclid', 'msclkid',
      'ref', 'source', 'si', 'feature', 'share',
      'mc_cid', 'mc_eid', 'pk_campaign', 'pk_kwd'
    ];
    
    trackingParams.forEach(param => url.searchParams.delete(param));
    
    return url.toString();
  } catch (error) {
    // If invalid URL, return original (will be validated later)
    return originalUrl;
  }
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
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 
      'utm_term', 'utm_content', 'utm_id',
      'fbclid', 'mibextid', 'gclid', 'msclkid',
      'ref', 'source', 'si', 'feature', 'share'
    ];
    return params.some(param => trackingParams.includes(param));
  } catch (e) {
    return false;
  }
}

module.exports = {
  cleanUrl,
  hasTrackingParams
};