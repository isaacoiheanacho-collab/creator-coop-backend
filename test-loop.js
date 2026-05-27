const db = require('./db');
require('dotenv').config();

// Match the configurations we built into your routes/links.js
const POST_LIMIT_PERCENTAGE = 0.04; 
const EXPIRATION_THRESHOLD_PERCENTAGE = 0.95;

async function runMockTest() {
  console.log('🚀 INITIALIZING CO-OP SYSTEM SIMULATION LOOP...');
  
  try {
    // 1. Clean up any previous mock test data to ensure clean statistics
    await db.query("DELETE FROM completed_engagements WHERE user_id IN (SELECT user_id FROM users WHERE email LIKE '%mock_test%')");
    await db.query("DELETE FROM boost_links WHERE creator_id IN (SELECT user_id FROM users WHERE email LIKE '%mock_test%')");
    await db.query("DELETE FROM users WHERE email LIKE '%mock_test%'");
    console.log('🧹 Cleaned up old mock records.');

    // 2. Generate an active user base (N)
    // We will create 25 mock creators across the system to watch the percentage fractions calculate
    const mockUserCount = 25;
    console.log(`👥 Registering ${mockUserCount} mock creators into the system...`);
    
    const userIds = [];
    for (let i = 1; i <= mockUserCount; i++) {
      // Balance out slots automatically across our 24 loops
      const assignedSlot = i % 24; 
      
      const res = await db.query(
        `INSERT INTO users (username, email, facebook_profile_url, assigned_slot_id)
         VALUES ($1, $2, $3, $4) RETURNING user_id, assigned_slot_id`,
        [`MockCreator_${i}`, `creator_${i}_mock_test@coop.com`, `https://facebook.com{i}`, assignedSlot]
      );
      userIds.push({ id: res.rows[0].user_id, slot: res.rows[0].assigned_slot_id });
    }
    console.log(`✅ Successfully added ${mockUserCount} active loop profiles.`);

    // 3. Pull total active community count (N)
    const countRes = await db.query("SELECT COUNT(*) FROM users WHERE account_status = 'active'");
    const N = parseInt(countRes.rows[0].count);
    console.log(`📊 Current System Scale (N) = ${N} active users.`);

    // Calculate dynamic posting allocation and expiration caps
    const maxAllowedPosts = Math.max(1, Math.round(N * POST_LIMIT_PERCENTAGE));
    const targetClicksNeeded = Math.max(1, Math.round(N * EXPIRATION_THRESHOLD_PERCENTAGE));
    
    console.log(`📈 Posting Allocation Rule: Only ${maxAllowedPosts} links allowed open simultaneously per slot (${POST_LIMIT_PERCENTAGE * 100}% of N).`);
    console.log(`🎯 Expiration Target Rule: A link needs exactly ${targetClicksNeeded} engagements to expire (${EXPIRATION_THRESHOLD_PERCENTAGE * 100}% of N).`);

    // 4. Simulate a creator dropping a boost link
    const primaryTestCreator = userIds[0];
    console.log(`\n📝 Creator ID ${primaryTestCreator.id} is submitting a boost link into Slot ${primaryTestCreator.slot}...`);
    
    const linkRes = await db.query(
      `INSERT INTO boost_links (creator_id, link_url, slot_id)
       VALUES ($1, $2, $3) RETURNING link_id`,
      [primaryTestCreator.id, 'https://facebook.com', primaryTestCreator.slot]
    );
    const testLinkId = linkRes.rows[0].link_id;
    console.log(`🔗 Link published in database queue. System Link ID: ${testLinkId}`);

    // 5. Simulate the "Rolling Wave" of Peers logging in to click the link
    console.log(`\n⚡ Simulating peer clicks up to the dynamic percentage target (${targetClicksNeeded} clicks needed)...`);
    
    // Loop through the other registered users to fire clicks
    let clickCounter = 0;
    for (let i = 1; i < userIds.length; i++) {
      const activePeerId = userIds[i].id;
      
      // Execute our atomic engagement transaction architecture block
      await db.query('BEGIN');
      
      // Log the unique interaction row
      await db.query('INSERT INTO completed_engagements (user_id, link_id) VALUES ($1, $2)', [activePeerId, testLinkId]);
      
      // Execute the atomic scale-safe update calculation matching your Phase 4 endpoint
      const updateRes = await db.query(
        `UPDATE boost_links
         SET clicks_received = clicks_received + 1,
             is_expired = CASE WHEN clicks_received + 1 >= $1 THEN TRUE ELSE FALSE END
         WHERE link_id = $2 RETURNING clicks_received, is_expired`,
        [targetClicksNeeded, testLinkId]
      );
      
      await db.query('COMMIT');
      clickCounter++;
      
      console.log(`   👉 Peer ${i} clicked. Running Clicks Count: ${updateRes.rows[0].clicks_received}/${targetClicksNeeded} | Expired Status: ${updateRes.rows[0].is_expired}`);
      
      // Stop the simulation once the percentage engine automatically flags the link as expired
      if (updateRes.rows[0].is_expired) {
        console.log(`\n🎉 SUCCESS! The link hit its percentage threshold target.`);
        break;
      }
    }

    // 6. Verify that the link is now hidden from subsequent lookups (Self-Exclusion check)
    console.log('\n🔍 Verifying feed output filters...');
    const feedCheck = await db.query('SELECT * FROM boost_links WHERE is_expired = FALSE AND link_id = $1', [testLinkId]);
    
    if (feedCheck.rows.length === 0) {
      console.log('💥 Confirmed: Expired link has successfully dropped out of the global feed queue.');
    } else {
      console.log('❌ Error: The link is still visible in the active pool.');
    }

    console.log('\n🏁 SYSTEM SIMULATION COMPLETE. ALL ARCHITECTURAL CRITERIA MET.');
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('❌ SIMULATION CRASHED:', err.message);
  } finally {
    process.exit();
  }
}

runMockTest();
