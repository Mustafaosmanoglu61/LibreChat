import { useQuery } from '@tanstack/react-query';
import { dataService, QueryKeys } from 'librechat-data-provider';
import type { TConnectionsResponse } from 'librechat-data-provider';
import type { UseQueryResult } from '@tanstack/react-query';

export const useConnectionsQuery = (enabled = true): UseQueryResult<TConnectionsResponse> =>
  useQuery<TConnectionsResponse>([QueryKeys.connections], () => dataService.getConnections(), {
    enabled,
    refetchOnWindowFocus: false,
  });
