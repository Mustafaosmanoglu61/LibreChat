import { useMutation, useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, MutationKeys } from 'librechat-data-provider';
import type {
  TConnectionStatus,
  TConnectionTarget,
  TConnectionStartResponse,
  TConnectionCompleteRequest,
} from 'librechat-data-provider';
import type { UseMutationResult } from '@tanstack/react-query';

export const useStartConnectionMutation = (): UseMutationResult<
  TConnectionStartResponse,
  unknown,
  TConnectionTarget
> =>
  useMutation((target: TConnectionTarget) => dataService.startConnection(target), {
    mutationKey: [MutationKeys.startConnection],
  });

export const useCompleteConnectionMutation = (): UseMutationResult<
  TConnectionStatus,
  unknown,
  TConnectionCompleteRequest
> => {
  const queryClient = useQueryClient();
  return useMutation(
    (payload: TConnectionCompleteRequest) => dataService.completeConnection(payload),
    {
      mutationKey: [MutationKeys.completeConnection],
      onSuccess: () => {
        queryClient.invalidateQueries([QueryKeys.connections]);
        queryClient.invalidateQueries([QueryKeys.models]);
      },
    },
  );
};

export const useDisconnectConnectionMutation = (): UseMutationResult<
  void,
  unknown,
  TConnectionTarget
> => {
  const queryClient = useQueryClient();
  return useMutation((target: TConnectionTarget) => dataService.disconnectConnection(target), {
    mutationKey: [MutationKeys.disconnectConnection],
    onSuccess: () => {
      queryClient.invalidateQueries([QueryKeys.connections]);
    },
  });
};
