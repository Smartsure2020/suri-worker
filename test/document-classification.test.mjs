// =============================================================
// Document classification, completeness ordering, and HEIC tests.
// Run with: npm test  (node --test)
// =============================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDocumentClassifications,
  runCompletenessCheck,
  buildDocumentPayloads,
} from '../suri-processor.js';

const doc = (id, filename, type = null, mime = 'application/pdf') =>
  ({ id, original_filename: filename, document_type: type, mime_type: mime, storage_path: `claims/x/${filename}` });

// ---------- Classification matching ----------

test('classifies by 1-based document_index', () => {
  const docs = [doc('d1', 'a.pdf'), doc('d2', 'b.pdf')];
  const { documents, assignments } = applyDocumentClassifications(docs, [
    { document_index: 2, original_filename: 'b.pdf', document_type: 'repair_quote' },
  ]);
  assert.equal(documents[1].document_type, 'repair_quote');
  assert.equal(documents[0].document_type, null);
  assert.deepEqual(assignments, [{ docId: 'd2', document_type: 'repair_quote' }]);
});

test('duplicate filenames with index classify the correct document', () => {
  const docs = [doc('d1', 'IMG_001.jpg'), doc('d2', 'IMG_001.jpg')];
  const { documents } = applyDocumentClassifications(docs, [
    { document_index: 1, original_filename: 'IMG_001.jpg', document_type: 'photos' },
    { document_index: 2, original_filename: 'IMG_001.jpg', document_type: 'id_document' },
  ]);
  assert.equal(documents[0].document_type, 'photos');
  assert.equal(documents[1].document_type, 'id_document');
});

test('duplicate filenames WITHOUT index are left unclassified, never guessed', () => {
  const docs = [doc('d1', 'IMG_001.jpg'), doc('d2', 'IMG_001.jpg')];
  const { documents, assignments } = applyDocumentClassifications(docs, [
    { original_filename: 'IMG_001.jpg', document_type: 'photos' },
  ]);
  assert.equal(documents[0].document_type, null);
  assert.equal(documents[1].document_type, null);
  assert.equal(assignments.length, 0);
});

test('unique filename without index still matches; out-of-range index falls back to filename', () => {
  const docs = [doc('d1', 'claim.pdf')];
  const byName = applyDocumentClassifications(docs, [
    { original_filename: 'claim.pdf', document_type: 'claim_form' },
  ]);
  assert.equal(byName.documents[0].document_type, 'claim_form');

  const badIndex = applyDocumentClassifications(docs, [
    { document_index: 99, original_filename: 'claim.pdf', document_type: 'claim_form' },
  ]);
  assert.equal(badIndex.documents[0].document_type, 'claim_form');
});

test('does not mutate the input document rows', () => {
  const docs = [doc('d1', 'a.pdf')];
  applyDocumentClassifications(docs, [{ document_index: 1, document_type: 'claim_form' }]);
  assert.equal(docs[0].document_type, null);
});

// ---------- Ordering fix: supplied documents are not falsely "missing" ----------

test('first-run claims: completeness sees classifications applied in-memory', () => {
  const rulePack = { required_documents: ['claim_form', 'repair_quote'], optional_documents: [] };
  // Fresh from the DB: document_type is null on every row (first run).
  const docs = [doc('d1', 'form.pdf'), doc('d2', 'quote.pdf')];

  // Without applying classifications, everything looks missing (the old bug).
  const before = runCompletenessCheck(docs, rulePack);
  assert.deepEqual(before.outstanding, ['claim_form', 'repair_quote']);

  // With classifications applied first, nothing is missing.
  const { documents } = applyDocumentClassifications(docs, [
    { document_index: 1, document_type: 'claim_form' },
    { document_index: 2, document_type: 'repair_quote' },
  ]);
  const after = runCompletenessCheck(documents, rulePack);
  assert.deepEqual(after.outstanding, []);
  assert.equal(after.score, 1);
});

// ---------- HEIC handling ----------

test('HEIC documents become manual-review notes, never image payloads', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });

  const docs = [
    doc('d1', 'report.pdf', null, 'application/pdf'),
    doc('d2', 'photo.heic', null, 'image/heic'),
    doc('d3', 'photo.jpg', null, 'image/jpeg'),
  ];
  const payloads = await buildDocumentPayloads(docs, { SUPABASE_URL: 'http://sb.local', SUPABASE_SERVICE_KEY: 'k' });

  assert.equal(payloads.length, 3, 'one payload per document, order preserved');
  assert.equal(payloads[0].type, 'document');
  assert.equal(payloads[1].type, 'text');
  assert.ok(payloads[1].text.includes('HEIC'));
  assert.ok(payloads[1].text.includes('photo.heic'));
  assert.equal(payloads[2].type, 'image');
  assert.equal(payloads[2].source.media_type, 'image/jpeg');
  // The old bug: HEIC bytes relabelled as image/jpeg. Must never happen.
  assert.equal(payloads.filter(p => p.type === 'image').length, 1);
});
