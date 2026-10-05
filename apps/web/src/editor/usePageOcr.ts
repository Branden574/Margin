import { useLayoutEffect, useRef, useState } from 'react';
import { PermissionFlag, type PDFDocumentProxy } from 'pdfjs-dist';
import type { OcrPageRecord } from '@margin/core';
import { getPageOcr, savePageOcr } from '../lib/storage';
import { createVaultGuard, onVaultLock } from '../lib/vault';
import { rasterizeOcrPage, pixelBoxToPdfQuad } from './ocrPage';
import { recognizeRaster } from './ocrEngine';
import { prepareOcrAssets } from './ocrAssets';
interface Snapshot {
  pdf: PDFDocumentProxy;
  documentId: string;
  pageIndex: number;
  revision: string;
  record?: OcrPageRecord;
  loading: boolean;
  active: boolean;
  message: string;
  error: string;
  canHighlight: boolean;
  offlineReady?: boolean;
}
export function usePageOcr(
  pdf: PDFDocumentProxy | null,
  documentId: string,
  revision: string,
  pageIndex: number,
  enabled: boolean,
  onSaved: () => void,
) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const job = useRef<AbortController | null>(null);
  const current = useRef({ pdf, documentId, revision, pageIndex, enabled });
  current.current = { pdf, documentId, revision, pageIndex, enabled };
  useLayoutEffect(() => {
    job.current?.abort();
    job.current = null;
    if (!pdf || !revision || !enabled) {
      setSnapshot(null);
      return;
    }
    const controller = new AbortController();
    const identity = { pdf, documentId, pageIndex, revision };
    setSnapshot({
      ...identity,
      loading: true,
      active: false,
      message: '',
      error: '',
      canHighlight: false,
    });
    const timer = setTimeout(() => {
      controller.abort();
      setSnapshot({
        ...identity,
        loading: false,
        active: false,
        message: '',
        error: 'Opening recognized text took too long. Reopen this document to retry.',
        canHighlight: false,
      });
    }, 20_000);
    void Promise.all([getPageOcr(documentId, revision, pageIndex), pdf.getPermissions()])
      .then(
        ([record, permissions]) => {
          if (!controller.signal.aborted)
            setSnapshot({
              ...identity,
              record,
              loading: false,
              active: false,
              message: '',
              error: '',
              canHighlight:
                permissions === null || permissions.has(PermissionFlag.MODIFY_ANNOTATIONS),
            });
        },
        () => {
          if (!controller.signal.aborted)
            setSnapshot({
              ...identity,
              loading: false,
              active: false,
              message: '',
              error: 'Saved recognized text could not be opened.',
              canHighlight: false,
            });
        },
      )
      .finally(() => clearTimeout(timer));
    const locked = onVaultLock(() => {
      controller.abort();
      job.current?.abort();
      setSnapshot(null);
    });
    return () => {
      clearTimeout(timer);
      controller.abort();
      job.current?.abort();
      job.current = null;
      locked();
    };
  }, [pdf, documentId, revision, pageIndex, enabled]);
  const visible =
    snapshot?.pdf === pdf &&
    snapshot.documentId === documentId &&
    snapshot.pageIndex === pageIndex &&
    snapshot.revision === revision &&
    enabled
      ? snapshot
      : null;
  async function recognize() {
    if (!pdf || !revision || !enabled || job.current || visible?.loading) return;
    const identity = current.current;
    const controller = new AbortController();
    job.current = controller;
    const interruption = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        'abort',
        () => reject(new DOMException('Recognition cancelled.', 'AbortError')),
        { once: true },
      ),
    );
    const wait = <T>(promise: Promise<T>) => Promise.race([promise, interruption]);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 180_000);
    const isCurrent = () =>
      current.current.pdf === identity.pdf &&
      current.current.documentId === identity.documentId &&
      current.current.revision === identity.revision &&
      current.current.pageIndex === identity.pageIndex &&
      current.current.enabled;
    const update = (patch: Partial<Snapshot>) => {
      if (isCurrent()) setSnapshot((s) => (s ? { ...s, ...patch } : s));
    };
    update({ active: true, error: '', message: 'Preparing local recognition…' });
    try {
      const guard = createVaultGuard();
      // Verify extraction permission before loading even the public engine assets.
      const permissions = await wait(pdf.getPermissions());
      if (
        permissions !== null &&
        !permissions.has(PermissionFlag.COPY) &&
        !permissions.has(PermissionFlag.COPY_FOR_ACCESSIBILITY)
      )
        throw new Error('This PDF does not allow text recognition.');
      controller.signal.throwIfAborted();
      guard();
      const assets = await wait(
        prepareOcrAssets(controller.signal, ({ phase, completedBytes, totalBytes }) =>
          update({
            message:
              phase === 'checking'
                ? 'Checking the local recognition pack…'
                : `${phase === 'downloading' ? 'Downloading' : 'Verifying'} recognition pack${totalBytes ? ` · ${Math.round((completedBytes / totalBytes) * 100)}%` : ''}`,
          }),
        ),
      );
      update({ offlineReady: assets.offlineReady });
      controller.signal.throwIfAborted();
      guard();
      update({ message: 'Preparing this page…' });
      const raster = await rasterizeOcrPage(pdf, pageIndex, controller.signal);
      const result = await recognizeRaster({
        ...raster,
        signal: controller.signal,
        onProgress: ({ stage, progress }) =>
          update({
            message:
              stage === 'loading'
                ? 'Loading the local recognition engine…'
                : `Recognizing this page · ${Math.round(progress * 100)}%`,
          }),
      });
      controller.signal.throwIfAborted();
      guard();
      if (!isCurrent()) return;
      if (!result.text.trim() || !result.words.length) {
        update({ message: 'No printed text was found. Try a clearer scan.', active: false });
        return;
      }
      const record: OcrPageRecord = {
        schema: 1,
        documentId,
        contentRevision: revision,
        pageIndex,
        engine: 'tesseract.js/7.0.0',
        language: 'eng/1.0.0',
        text: result.text,
        words: result.words.map(({ box, ...word }) => ({
          ...word,
          quad: pixelBoxToPdfQuad(box, raster.transform),
        })),
        createdAt: new Date().toISOString(),
      };
      await savePageOcr(record, { signal: controller.signal });
      guard();
      controller.signal.throwIfAborted();
      update({ record, message: 'Recognized text saved encrypted on this device.', active: false });
      if (isCurrent()) onSaved();
    } catch (reason) {
      update({
        active: false,
        message: controller.signal.aborted && !timedOut ? 'Recognition cancelled.' : '',
        error: timedOut
          ? 'Recognition took too long. Try again with a smaller page.'
          : controller.signal.aborted
            ? ''
            : reason instanceof Error
              ? reason.message
              : 'This page could not be recognized.',
      });
    } finally {
      clearTimeout(timer);
      if (job.current === controller) job.current = null;
    }
  }
  return {
    record: visible?.record,
    loading: visible?.loading ?? Boolean(pdf && revision && enabled),
    active: visible?.active ?? false,
    message: visible?.message ?? '',
    error: visible?.error ?? '',
    canHighlight: visible?.canHighlight ?? false,
    offlineReady: visible?.offlineReady,
    recognize,
    cancel: () => job.current?.abort(),
  };
}
