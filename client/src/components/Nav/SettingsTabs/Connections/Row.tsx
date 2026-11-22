import { useState } from 'react';
import { Button, Spinner, useToastContext } from '@librechat/client';
import type { TConnectionStatus, TConnectionStartResponse } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useStartConnectionMutation, useDisconnectConnectionMutation } from '~/data-provider';
import { getConnectionError } from './errors';
import { useLocalize } from '~/hooks';
import Connect from './Connect';

/** Product names are proper nouns and stay untranslated. */
const providerLabels: Record<string, string> = { chatgpt: 'ChatGPT' };

type RowState = 'connected' | 'reauth' | 'disconnected';

const stateLabelKeys: Record<RowState, TranslationKeys> = {
  connected: 'com_ui_connections_status_connected',
  reauth: 'com_ui_connections_status_reauth',
  disconnected: 'com_ui_connections_status_disconnected',
};

const stateDotClasses: Record<RowState, string> = {
  connected: 'bg-status-success',
  reauth: 'bg-status-warning',
  disconnected: 'bg-status-neutral',
};

function getRowState(connection: TConnectionStatus): RowState {
  if (connection.connected) {
    return 'connected';
  }
  return connection.needsReauth ? 'reauth' : 'disconnected';
}

export default function Row({ connection }: { connection: TConnectionStatus }) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const start = useStartConnectionMutation();
  const disconnect = useDisconnectConnectionMutation();
  const [flow, setFlow] = useState<TConnectionStartResponse | null>(null);
  const target = { providerId: connection.providerId, endpoint: connection.endpoint };
  const label = providerLabels[connection.providerId] ?? connection.providerId;
  const state = getRowState(connection);
  const account = [connection.accountEmail, connection.plan].filter(Boolean).join(' · ');

  const begin = () =>
    start.mutate(target, {
      onSuccess: setFlow,
      onError: (error) =>
        showToast({ message: localize(getConnectionError(error).key), status: 'error' }),
    });

  const remove = () => {
    if (!window.confirm(localize('com_ui_connections_disconnect_confirm', { 0: label }))) {
      return;
    }
    disconnect.mutate(target, {
      onSuccess: () =>
        showToast({
          message: localize('com_ui_connections_disconnected_toast', { 0: label }),
          status: 'success',
        }),
      onError: () =>
        showToast({ message: localize('com_ui_connections_error_generic'), status: 'error' }),
    });
  };

  return (
    <li className="flex items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className={`size-2 shrink-0 rounded-full ${stateDotClasses[state]}`}
            aria-hidden="true"
          />
          <span className="truncate font-medium text-text-primary">{label}</span>
          {connection.endpoint !== label && (
            <span className="truncate text-xs text-text-secondary">{connection.endpoint}</span>
          )}
        </div>
        <div className="truncate text-xs text-text-secondary">
          {localize(stateLabelKeys[state])}
          {state === 'connected' && account ? ` · ${account}` : ''}
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {state !== 'connected' && (
          <Button variant="outline" onClick={begin} disabled={start.isLoading}>
            {start.isLoading ? (
              <Spinner className="size-4" />
            ) : (
              localize(
                state === 'reauth' ? 'com_ui_connections_reconnect' : 'com_ui_connections_connect',
              )
            )}
          </Button>
        )}
        {state !== 'disconnected' && (
          <Button variant="outline" onClick={remove} disabled={disconnect.isLoading}>
            {disconnect.isLoading ? (
              <Spinner className="size-4" />
            ) : (
              localize('com_ui_connections_disconnect')
            )}
          </Button>
        )}
      </div>
      {flow != null && (
        <Connect
          open
          onOpenChange={(open) => !open && setFlow(null)}
          connection={connection}
          label={label}
          flow={flow}
          onRestart={begin}
          restarting={start.isLoading}
        />
      )}
    </li>
  );
}
