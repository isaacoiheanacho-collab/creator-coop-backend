// scripts/run-cleanup.js
const { dailyCleanup, getStorageStats, getDatabaseSize } = require('../utils/cleanup');

async function run() {
  console.log('═══════════════════════════════════════════════');
  console.log('  🧹 DATABASE CLEANUP SCRIPT');
  console.log('═══════════════════════════════════════════════');
  console.log();

  // Get size before cleanup
  console.log('📊 Before cleanup:');
  const beforeSize = await getDatabaseSize();
  if (beforeSize) {
    console.log(`   Database size: ${beforeSize.size_mb} MB`);
  }
  console.log();

  // Run cleanup
  const result = await dailyCleanup();
  console.log();

  // Get size after cleanup
  console.log('📊 After cleanup:');
  const afterSize = await getDatabaseSize();
  if (afterSize) {
    console.log(`   Database size: ${afterSize.size_mb} MB`);
    if (beforeSize) {
      const saved = parseFloat(beforeSize.size_mb) - parseFloat(afterSize.size_mb);
      console.log(`   Space saved: ${saved.toFixed(2)} MB`);
    }
  }
  console.log();

  // Get storage stats
  console.log('📊 Storage Stats:');
  const stats = await getStorageStats();
  if (stats) {
    console.log(`   Total Users: ${stats.total_users}`);
    console.log(`   Total Boosts: ${stats.total_boosts}`);
    console.log(`   Active Boosts: ${stats.active_boosts}`);
    console.log(`   Total Notifications: ${stats.total_notifications}`);
    console.log(`   Unread Notifications: ${stats.unread_notifications}`);
    console.log(`   Active Sessions: ${stats.active_sessions}`);
    console.log(`   Total Engagements: ${stats.total_engagements}`);
    console.log(`   Recent Engagements (30d): ${stats.recent_engagements}`);
  }

  console.log();
  console.log('═══════════════════════════════════════════════');
  console.log('  ✅ Cleanup complete!');
  console.log('═══════════════════════════════════════════════');

  process.exit(0);
}

run().catch(err => {
  console.error('❌ Cleanup failed:', err);
  process.exit(1);
});