// utils/urlValidator.js

const SUPPORTED_PLATFORMS = {
  facebook: {
    patterns: [
      /^https?:\/\/(www\.)?facebook\.com\/.*/i,
      /^https?:\/\/(www\.)?fb\.com\/.*/i,
      /^https?:\/\/fb\.watch\/.*/i,
    ],
    label: 'Facebook'
  },
  instagram: {
    patterns: [
      /^https?:\/\/(www\.)?instagram\.com\/.*/i,
      /^https?:\/\/(www\.)?instagr\.am\/.*/i,
    ],
    label: 'Instagram'
  },
  tiktok: {
    patterns: [
      /^https?:\/\/(www\.)?tiktok\.com\/.*/i,
      /^https?:\/\/vm\.tiktok\.com\/.*/i,
      /^https?:\/\/vt\.tiktok\.com\/.*/i,
    ],
    label: 'TikTok'
  },
  x: {
    patterns: [
      /^https?:\/\/(www\.)?x\.com\/.*/i,
      /^https?:\/\/(www\.)?twitter\.com\/.*/i,
    ],
    label: 'X (Twitter)'
  },
  youtube: {
    patterns: [
      /^https?:\/\/(www\.)?youtube\.com\/.*/i,
      /^https?:\/\/youtu\.be\/.*/i,
    ],
    label: 'YouTube'
  },
  linkedin: {
    patterns: [
      /^https?:\/\/(www\.)?linkedin\.com\/.*/i,
    ],
    label: 'LinkedIn'
  },
  telegram: {
    patterns: [
      /^https?:\/\/(www\.)?telegram\.me\/.*/i,
      /^https?:\/\/(www\.)?t\.me\/.*/i,
    ],
    label: 'Telegram'
  }
};

/**
 * Validate if a URL is from a supported social media platform
 * @param {string} url - The URL to validate
 * @returns {Object} - { valid: boolean, platform: string, error: string }
 */
function validateSocialMediaUrl(url) {
  if (!url || typeof url !== 'string') {
    return {
      valid: false,
      platform: null,
      error: 'URL is required.'
    };
  }

  // Try to parse URL
  let urlObj;
  try {
    urlObj = new URL(url);
  } catch (e) {
    return {
      valid: false,
      platform: null,
      error: 'Invalid URL format. Please enter a valid URL.'
    };
  }

  // Check if URL matches any platform pattern
  for (const [platform, config] of Object.entries(SUPPORTED_PLATFORMS)) {
    for (const pattern of config.patterns) {
      if (pattern.test(url)) {
        return {
          valid: true,
          platform: platform,
          label: config.label,
          error: null
        };
      }
    }
  }

  // If no match found
  const supportedList = Object.values(SUPPORTED_PLATFORMS).map(p => p.label).join(', ');
  return {
    valid: false,
    platform: null,
    error: `Invalid Link. Please enter a valid URL from: ${supportedList}.`
  };
}

/**
 * Get platform from URL
 * @param {string} url - The URL
 * @returns {string} - Platform name or 'Other'
 */
function getPlatformFromUrl(url) {
  try {
    const domain = new URL(url).hostname.replace(/^www\./, '');
    for (const [platform, config] of Object.entries(SUPPORTED_PLATFORMS)) {
      for (const pattern of config.patterns) {
        if (pattern.test(url)) {
          return config.label;
        }
      }
    }
    return 'Other';
  } catch (e) {
    return 'Other';
  }
}

module.exports = {
  validateSocialMediaUrl,
  getPlatformFromUrl,
  SUPPORTED_PLATFORMS
};