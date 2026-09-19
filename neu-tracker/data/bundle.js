/* HDFC Tata Neu Credit Card Tracker — data bundle (portable saved state).
 * This default bundle ships EMPTY. Statements you import, ledger entries,
 * redemptions and payments you add are stored in your browser's localStorage
 * and exported here via "Save bundle". Nothing in this repo contains real
 * card/bill data.
 *   password is deliberately NOT stored in bundles — it lives only in
 *   localStorage on the device (never in bundle.js / the repo).
 */
window.DATA = {
  version: 2,
  card: { no: '', aan: '', name: '' },
  records: [],
  ledger: [],
  redemptions: [],
  payments: [],
  rewardsConfig: { valuePerCoin: 0.25 }
};