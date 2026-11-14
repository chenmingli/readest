import clsx from 'clsx';
import React, { useEffect, useRef, useState } from 'react';
import { useEnv } from '@/context/EnvContext';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { isWebAppPlatform } from '@/services/environment';
import { eventDispatcher } from '@/utils/event';
import { persistCloudProviderEnabled } from './cloudSync';
import { SectionTitle } from '../primitives';
import FileSyncForm from './FileSyncForm';
import QRCode from './QRCode';
import {
  P115Client,
  hasP115Login,
  type P115QrToken,
  type P115QrStatus,
} from '@/services/sync/providers/p115/client';
import type { P115Settings } from '@/types/settings';

const QR_STATUS_LABEL: Record<P115QrStatus, string> = {
  0: 'Scan the QR code with the 115 app',
  1: 'Scanned — confirm on your phone',
  2: 'Signed in',
  [-1]: 'QR code expired',
  [-2]: 'Sign-in canceled',
};

/**
 * 115 Netdisk provider panel. Sign-in is a QR handshake: the panel shows the
 * official QR image and exchanges the confirmed scan for the session cookie,
 * then turns the backend on with that cookie. Once active it hands the shared
 * sync controls to {@link FileSyncForm}.
 */
const P115Form: React.FC = () => {
  const _ = useTranslation();
  const { settings, setSettings, saveSettings } = useSettingsStore();
  const { envConfig } = useEnv();

  const stored = settings.p115;
  const signedIn = hasP115Login(stored?.cookie);
  const isActive = !!stored?.enabled && signedIn;

  const [rootPath, setRootPath] = useState(stored?.rootPath || '/');
  const [qr, setQr] = useState<P115QrToken | null>(null);
  const [qrStatus, setQrStatus] = useState<P115QrStatus>(0);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState('');
  const loginInFlight = useRef(false);

  const startSignIn = async () => {
    setIsStarting(true);
    setError('');
    try {
      const client = new P115Client('');
      const token = await client.qrToken();
      setQrStatus(0);
      setQr(token);
    } catch (e) {
      setError(e instanceof Error ? e.message : _('Could not reach 115'));
    } finally {
      setIsStarting(false);
    }
  };

  useEffect(() => {
    if (!qr) return;
    const client = new P115Client('');
    let cancelled = false;
    const timer = setInterval(async () => {
      if (loginInFlight.current) return;
      try {
        const status = await client.qrStatus(qr);
        if (cancelled) return;
        setQrStatus(status);
        if (status === 2) {
          loginInFlight.current = true;
          const cookie = await client.qrLogin(qr.uid);
          if (cancelled) return;
          await persistCloudProviderEnabled(envConfig, 'p115', true, (current) => ({
            ...current,
            p115: {
              ...(current.p115 as P115Settings),
              cookie,
              accountLabel: `UID ${qr.uid}`,
              rootPath: current.p115?.rootPath || '/',
            },
          }));
          setQr(null);
          eventDispatcher.dispatch('toast', { type: 'info', message: _('Connected to 115') });
        } else if (status === -1 || status === -2) {
          setError(_(QR_STATUS_LABEL[status]));
          setQr(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : _('Sign-in failed'));
      } finally {
        loginInFlight.current = false;
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qr, envConfig]);

  const handleDisconnect = async () => {
    await persistCloudProviderEnabled(envConfig, 'p115', false);
    setQr(null);
    eventDispatcher.dispatch('toast', { type: 'info', message: _('Disconnected') });
  };

  const persistP115 = async (patch: Partial<P115Settings>) => {
    const latest = useSettingsStore.getState().settings;
    const next = { ...latest, p115: { ...latest.p115, ...patch } };
    setSettings(next);
    await saveSettings(envConfig, next);
  };

  const persistRootPath = async () => {
    const normalized = `/${rootPath.replace(/^\/+|\/+$/g, '')}` || '/';
    setRootPath(normalized);
    await persistP115({ rootPath: normalized });
  };

  if (isWebAppPlatform()) {
    return (
      <p className='text-base-content/70 text-sm'>
        {_('115 Netdisk sync is available in the desktop app.')}
      </p>
    );
  }

  if (isActive) {
    return (
      <div className='space-y-5'>
        <div className='flex items-center justify-between gap-3'>
          <div className='min-w-0'>
            <SectionTitle as='span' className='block'>
              {_('115 Netdisk')}
            </SectionTitle>
            <p className='text-base-content/60 truncate text-xs'>
              {stored?.accountLabel || _('Signed in')}
            </p>
          </div>
        </div>

        <div className='space-y-1.5'>
          <SectionTitle as='label' htmlFor='p115-root' className='block'>
            {_('Root Directory')}
          </SectionTitle>
          <input
            id='p115-root'
            type='text'
            className='input eink-bordered h-11 w-full text-sm focus:outline-hidden'
            spellCheck='false'
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
            onBlur={persistRootPath}
          />
        </div>

        <FileSyncForm kind='p115' stored={stored} persist={persistP115} />

        <div className='flex justify-end'>
          <button
            type='button'
            onClick={handleDisconnect}
            className={clsx(
              'eink-bordered',
              'h-10 rounded-lg px-4 text-sm font-medium',
              'text-error hover:bg-error/10',
              'transition-colors duration-150',
              'focus-visible:ring-error/40 focus-visible:outline-hidden focus-visible:ring-2',
            )}
          >
            {_('Disconnect')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className='space-y-4'>
      <p className='text-base-content/70 text-sm'>
        {_('Sign in with the 115 app to sync your library into your 115 Netdisk.')}
      </p>

      {qr ? (
        <div className='flex flex-col items-center gap-3'>
          <div className='eink-bordered w-48 rounded-lg bg-white p-2'>
            <QRCode value={qr.qrcodeUrl} />
          </div>
          <p className='text-base-content/70 text-sm'>{_(QR_STATUS_LABEL[qrStatus])}</p>
          {error && <p className='text-error text-sm'>{error}</p>}
          <button
            type='button'
            onClick={() => {
              setQr(null);
              setError('');
            }}
            className='text-base-content/60 hover:text-base-content text-sm'
          >
            {_('Cancel')}
          </button>
        </div>
      ) : (
        <div className='flex flex-col gap-3'>
          {error && <p className='text-error text-sm'>{error}</p>}
          <button
            type='button'
            onClick={startSignIn}
            disabled={isStarting}
            className={clsx(
              'btn btn-contrast',
              'h-10 min-h-10 rounded-lg border-0 px-5 text-sm font-medium',
              'focus-visible:ring-base-content/40 focus-visible:outline-hidden focus-visible:ring-2',
              isStarting && 'opacity-60',
            )}
          >
            {isStarting ? (
              <span className='loading loading-spinner loading-sm' />
            ) : (
              _('Sign in with 115')
            )}
          </button>
          {signedIn && (
            <button
              type='button'
              onClick={() =>
                persistCloudProviderEnabled(envConfig, 'p115', true, (current) => current)
              }
              className='text-base-content/70 hover:text-base-content text-sm underline'
            >
              {_('Reconnect saved account')}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default P115Form;
