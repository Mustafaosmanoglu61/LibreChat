import { Button, Spinner } from '@librechat/client';
import { useConnectionsQuery } from '~/data-provider';
import { useLocalize } from '~/hooks';
import Row from './Row';

/** Accounts a user connects to chat on their own provider plan instead of an operator key. */
export function Connections() {
  const localize = useLocalize();
  const { data, isLoading, isError, refetch } = useConnectionsQuery();

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-text-secondary" role="status">
        <Spinner className="size-4" />
        {localize('com_ui_connections_loading')}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center justify-between gap-3" role="alert">
        <span className="text-sm text-text-warning">
          {localize('com_ui_connections_load_error')}
        </span>
        <Button variant="outline" onClick={() => refetch()}>
          {localize('com_ui_retry')}
        </Button>
      </div>
    );
  }

  const connections = data?.connections ?? [];

  return (
    <div className="space-y-2">
      <p className="text-sm text-text-secondary">{localize('com_ui_connections_description')}</p>
      {connections.length === 0 ? (
        <p className="text-sm text-text-secondary">{localize('com_ui_connections_empty')}</p>
      ) : (
        <ul
          className="divide-y divide-border-light"
          aria-label={localize('com_ui_connections_title')}
        >
          {connections.map((connection) => (
            <Row key={`${connection.providerId}:${connection.endpoint}`} connection={connection} />
          ))}
        </ul>
      )}
    </div>
  );
}
