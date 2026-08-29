import pg from 'pg';

const client = new pg.Client({
  host: '127.0.0.1',
  port: 3099,
  database: 'catalog',
  user: 'postgres',
  password: ''
});

await client.connect();

console.log('\n=== IKEA Catalog Import Verification ===\n');

const metrics = [
  { name: 'Total Products (SE market, ready)', query: 'SELECT COUNT(*) as count FROM products WHERE market = \'SE\' AND status = \'ready\'' },
  { name: 'Product Aliases', query: 'SELECT COUNT(*) as count FROM product_aliases' },
  { name: 'Media Assets (Manuals)', query: 'SELECT COUNT(*) as count FROM media_assets WHERE kind = \'manual_pdf\'' },
  { name: 'Source Documents (Manuals)', query: 'SELECT COUNT(*) as count FROM source_documents WHERE kind = \'manual\' AND status = \'ready\'' },
  { name: 'Product-Manual Links', query: 'SELECT COUNT(*) as count FROM product_documents' },
  { name: 'Unique Manual URLs', query: 'SELECT COUNT(DISTINCT canonical_url) as count FROM source_documents WHERE kind = \'manual\'' }
];

for (const metric of metrics) {
  const result = await client.query(metric.query);
  console.log(`${metric.name}: ${result.rows[0].count}`);
}

console.log('\nLanguage Distribution:');
const langResult = await client.query('SELECT locale, COUNT(*) as count FROM source_documents WHERE kind = \'manual\' GROUP BY locale ORDER BY count DESC');
for (const row of langResult.rows) {
  console.log(`  ${row.locale}: ${row.count}`);
}

console.log('\nCategory Distribution (top 10):');
const catResult = await client.query('SELECT category, COUNT(*) as count FROM products WHERE market = \'SE\' GROUP BY category ORDER BY count DESC LIMIT 10');
for (const row of catResult.rows) {
  console.log(`  ${row.category}: ${row.count}`);
}

console.log('\nBatch Information:');
const batchResult = await client.query('SELECT name, status, expected_items FROM ingestion_batches');
for (const row of batchResult.rows) {
  console.log(`  ${row.name}: ${row.status} (expected: ${row.expected_items})`);
}

// Verify all products have manuals
const noManualResult = await client.query(`
  SELECT COUNT(*) as count FROM products p
  WHERE p.market = 'SE' AND p.status = 'ready'
  AND NOT EXISTS (
    SELECT 1 FROM product_documents pd
    JOIN source_documents sd ON sd.id = pd.document_id
    WHERE pd.product_id = p.id AND sd.kind = 'manual' AND sd.status = 'ready'
  )
`);
console.log(`\nProducts without manuals: ${noManualResult.rows[0].count}`);

// Sample products
console.log('\nSample Products:');
const sampleResult = await client.query(`
  SELECT p.rank, p.name, p.ikea_item_number, p.category, p.popularity_rank
  FROM products p
  WHERE p.market = 'SE'
  ORDER BY p.rank LIMIT 10
`);
for (const row of sampleResult.rows) {
  console.log(`  [${row.rank}] ${row.name} (${row.ikea_item_number}) - ${row.category}`);
}

await client.end();
