import { useState } from 'react';
import {
  Label,
  Input,
  Button,
  Spinner,
  OGDialog,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogContent,
  useToastContext,
} from '@librechat/client';
import type { TConnectionStatus, TConnectionStartResponse } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useCompleteConnectionMutation } from '~/data-provider';
import { getConnectionError } from './errors';
import { useLocalize } from '~/hooks';

interface ConnectProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  connection: TConnectionStatus;
  label: string;
  flow: TConnectionStartResponse;
  onRestart: () => void;
  restarting: boolean;
}

/**
 * Two steps: consent opens in a new tab through a real link (never popup-blocked), then the
 * user pastes back the address that tab lands on, which carries the one-time code.
 */
export default function Connect({
  open,
  onOpenChange,
  connection,
  label,
  flow,
  onRestart,
  restarting,
}: ConnectProps) {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const complete = useCompleteConnectionMutation();
  const [callbackUrl, setCallbackUrl] = useState('');
  const [error, setError] = useState<{ key: TranslationKeys; restart: boolean } | null>(null);
  const inputId = `connection-callback-${connection.providerId}-${connection.endpoint}`;
  const errorId = `${inputId}-error`;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    complete.mutate(
      {
        providerId: connection.providerId,
        endpoint: connection.endpoint,
        flowId: flow.flowId,
        callbackUrl: callbackUrl.trim(),
      },
      {
        onSuccess: () => {
          showToast({
            message: localize('com_ui_connections_connected_toast', { 0: label }),
            status: 'success',
          });
          onOpenChange(false);
        },
        onError: (err) => setError(getConnectionError(err)),
      },
    );
  };

  const restart = () => {
    setError(null);
    setCallbackUrl('');
    onRestart();
  };

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent
        className="w-11/12 max-w-lg bg-surface-dialog text-text-primary"
        aria-describedby={undefined}
      >
        <OGDialogHeader className="text-left">
          <OGDialogTitle>{localize('com_ui_connections_dialog_title', { 0: label })}</OGDialogTitle>
        </OGDialogHeader>
        <form className="space-y-5" onSubmit={submit}>
          <section className="space-y-2">
            <p className="text-sm text-text-primary">{localize('com_ui_connections_step_open')}</p>
            <Button asChild variant="outline" className="w-full">
              <a href={flow.authorizeUrl} target="_blank" rel="noopener noreferrer">
                {localize('com_ui_connections_open_provider', { 0: label })}
              </a>
            </Button>
          </section>
          <section className="space-y-2">
            <p className="text-sm text-text-primary">
              {localize('com_ui_connections_step_paste', { 0: flow.redirectUri ?? '' })}
            </p>
            <Label htmlFor={inputId}>{localize('com_ui_connections_paste_label')}</Label>
            <Input
              id={inputId}
              value={callbackUrl}
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder={`${flow.redirectUri ?? ''}?code=…`}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error != null}
              aria-describedby={error != null ? errorId : undefined}
            />
            {error != null && (
              <p id={errorId} role="alert" className="text-sm text-text-warning">
                {localize(error.key)}
              </p>
            )}
          </section>
          <div className="flex justify-end gap-2">
            {error?.restart === true ? (
              <Button type="button" onClick={restart} disabled={restarting}>
                {restarting ? (
                  <Spinner className="size-4" />
                ) : (
                  localize('com_ui_connections_restart')
                )}
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={callbackUrl.trim().length === 0 || complete.isLoading}
              >
                {complete.isLoading ? (
                  <Spinner className="size-4" />
                ) : (
                  localize('com_ui_connections_complete')
                )}
              </Button>
            )}
          </div>
        </form>
      </OGDialogContent>
    </OGDialog>
  );
}
