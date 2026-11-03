const Transaction = require('../models/Transaction.model');

// Indexes that older versions of the schema created and that are now redundant (see Transaction.model.js).
// Mongoose never drops indexes by itself, so existing databases keep paying for them on every insert until removed.
const REDUNDANT = ['jobId_1', 'account_1', 'fromBank_1'];

async function dropRedundantTransactionIndexes() {
  if (process.env.DROP_REDUNDANT_INDEXES === 'false') return [];
  const dropped = [];
  try {
    const existing = (await Transaction.collection.indexes()).map((i) => i.name);
    for (const name of REDUNDANT) {
      if (!existing.includes(name)) continue;
      try { await Transaction.collection.dropIndex(name); dropped.push(name); }
      catch (err) { console.warn(`⚠️  could not drop index ${name}: ${err.message}`); }
    }
    if (dropped.length) console.log(`🗂️  Dropped redundant Transaction indexes (faster inserts): ${dropped.join(', ')}`);
  } catch (err) {
    console.warn(`⚠️  index maintenance skipped: ${err.message}`); // e.g. collection does not exist yet
  }
  return dropped;
}

module.exports = { dropRedundantTransactionIndexes, REDUNDANT };
