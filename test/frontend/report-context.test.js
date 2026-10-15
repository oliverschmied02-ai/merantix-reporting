import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({
  getReportContext: vi.fn(),
  saveReportContext: vi.fn(async () => ({ ok: true })),
  uploadReportDocument: vi.fn(async () => ({ id: 9, status: 'pending' })),
  reextractReportDocument: vi.fn(),
  updateReportDocument: vi.fn(async () => ({ ok: true })),
  deleteReportDocument: vi.fn(),
}));
vi.mock('../../src/lib/db.js', () => db);

import { APP, resetAPP } from '../../src/state.js';
import { mrOpenContext, mrContextInput, mrUploadDoc } from '../../src/ui/report-context.js';

const CTX = {
  content: 'Management Fee 2 %',
  documents: [
    { id: 1, filename: 'LPA.pdf', size_bytes: 2 * 1048576, status: 'ready', summary: 'Fee quartalsweise', created_at: '2026-10-15' },
    { id: 2, filename: 'Side Letter.pdf', size_bytes: 40000, status: 'pending', summary: '', created_at: '2026-10-15' },
  ],
};

describe('Report context panel', () => {
  beforeEach(() => {
    resetAPP();
    Object.values(db).forEach(f => f.mockClear());
    db.getReportContext.mockResolvedValue(structuredClone(CTX));
    document.body.innerHTML = `<div id="toast"></div><div id="mr-ctx-panel" class="hidden"></div>`;
  });

  it('lets admins edit the context and upload documents', async () => {
    APP.currentUserRole = 'admin';
    await mrOpenContext();
    const text = document.querySelector('.mr-ctx-text');
    expect(text.value).toBe('Management Fee 2 %');
    expect(text.hasAttribute('readonly')).toBe(false);
    expect(document.getElementById('mr-ctx-file')).not.toBeNull();
    expect(document.querySelector('.mr-ctx-doc-text').value).toBe('Fee quartalsweise');
    expect(document.getElementById('mr-ctx-docs').textContent).toContain('Claude wertet das Dokument aus');

    vi.useFakeTimers();
    text.value = 'Management Fee 2 % auf Commitments';
    mrContextInput(text);
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    expect(db.saveReportContext).toHaveBeenCalledWith('Management Fee 2 % auf Commitments');
  });

  it('is read-only for non-admins', async () => {
    APP.currentUserRole = 'viewer';
    await mrOpenContext();
    expect(document.querySelector('.mr-ctx-text').hasAttribute('readonly')).toBe(true);
    expect(document.getElementById('mr-ctx-file')).toBeNull();
    mrContextInput(document.querySelector('.mr-ctx-text'));
    expect(db.saveReportContext).not.toHaveBeenCalled();
  });

  it('uploads a PDF as base64 and refuses Word files', async () => {
    APP.currentUserRole = 'admin';
    await mrOpenContext();

    const docx = { files: [new File(['x'], 'LPA.docx', { type: 'application/msword' })], value: 'x' };
    await mrUploadDoc(docx);
    expect(db.uploadReportDocument).not.toHaveBeenCalled();

    const pdf = { files: [new File(['%PDF-1.4'], 'LPA.pdf', { type: 'application/pdf' })], value: 'x' };
    await mrUploadDoc(pdf);
    expect(db.uploadReportDocument).toHaveBeenCalledWith('LPA.pdf', 'application/pdf', btoa('%PDF-1.4'));
  });
});
