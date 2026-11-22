import { AxiosError } from 'axios';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import type { TConnectionStatus } from 'librechat-data-provider';
import { Connections } from '../Connections';

const mockQuery = jest.fn();
const mockRefetch = jest.fn();
const mockStart = jest.fn();
const mockComplete = jest.fn();
const mockDisconnect = jest.fn();
const mockToast = jest.fn();

jest.mock('~/data-provider', () => ({
  useConnectionsQuery: () => mockQuery(),
  useStartConnectionMutation: () => ({ mutate: mockStart, isLoading: false }),
  useCompleteConnectionMutation: () => ({ mutate: mockComplete, isLoading: false }),
  useDisconnectConnectionMutation: () => ({ mutate: mockDisconnect, isLoading: false }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: mockToast }),
}));

const REDIRECT = 'http://127.0.0.1:1455/auth/callback';
const flow = {
  flowId: 'flow-1',
  authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=s1',
  redirectUri: REDIRECT,
};

const base: TConnectionStatus = {
  providerId: 'chatgpt',
  endpoint: 'ChatGPT',
  connected: false,
  needsReauth: false,
};

function withConnections(connections: TConnectionStatus[]) {
  mockQuery.mockReturnValue({
    isLoading: false,
    isError: false,
    refetch: mockRefetch,
    data: { connections },
  });
}

const flowError = (code: string) =>
  Object.assign(new AxiosError('failed'), { response: { status: 400, data: { code } } });

async function openConnectDialog() {
  mockStart.mockImplementation((_target, options) => options?.onSuccess?.(flow));
  await userEvent.click(screen.getByRole('button', { name: 'com_ui_connections_connect' }));
  return screen.getByRole('dialog');
}

beforeEach(() => {
  jest.clearAllMocks();
  global.ResizeObserver = class MockedResizeObserver {
    observe = jest.fn();
    unobserve = jest.fn();
    disconnect = jest.fn();
  };
});

describe('Connections', () => {
  it('shows a loading state', () => {
    mockQuery.mockReturnValue({ isLoading: true, isError: false, refetch: mockRefetch });
    render(<Connections />);
    expect(screen.getByRole('status')).toHaveTextContent('com_ui_connections_loading');
  });

  it('offers a retry when the list fails to load', async () => {
    mockQuery.mockReturnValue({ isLoading: false, isError: true, refetch: mockRefetch });
    render(<Connections />);

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_connections_load_error');
    await userEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('says so when the deployment offers no connections', () => {
    withConnections([]);
    render(<Connections />);
    expect(screen.getByText('com_ui_connections_empty')).toBeInTheDocument();
  });

  it.each([
    [{ connected: true }, 'com_ui_connections_status_connected', ['com_ui_connections_disconnect']],
    [
      { needsReauth: true },
      'com_ui_connections_status_reauth',
      ['com_ui_connections_reconnect', 'com_ui_connections_disconnect'],
    ],
    [{}, 'com_ui_connections_status_disconnected', ['com_ui_connections_connect']],
  ])('renders %o with its status and only the actions that apply', (state, statusKey, actions) => {
    withConnections([{ ...base, accountEmail: 'user@example.com', plan: 'plus', ...state }]);
    render(<Connections />);

    const row = screen.getByRole('listitem');
    expect(within(row).getByText('ChatGPT')).toBeInTheDocument();
    expect(row).toHaveTextContent(statusKey);
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(actions);
  });

  it('shows the account only once it is connected', () => {
    withConnections([{ ...base, connected: true, accountEmail: 'user@example.com', plan: 'plus' }]);
    render(<Connections />);
    expect(screen.getByRole('listitem')).toHaveTextContent('user@example.com · plus');
  });

  it('connects: opens consent through a real link, then completes from the pasted address', async () => {
    withConnections([base]);
    mockComplete.mockImplementation((_payload, options) => options?.onSuccess?.(base));
    render(<Connections />);

    const dialog = await openConnectDialog();
    expect(mockStart).toHaveBeenCalledWith(
      { providerId: 'chatgpt', endpoint: 'ChatGPT' },
      expect.any(Object),
    );
    const link = within(dialog).getByRole('link', { name: 'com_ui_connections_open_provider' });
    expect(link).toHaveAttribute('href', flow.authorizeUrl);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    await userEvent.type(
      within(dialog).getByLabelText('com_ui_connections_paste_label'),
      `  ${REDIRECT}?code=abc&state=s1 `,
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'com_ui_connections_complete' }),
    );

    expect(mockComplete).toHaveBeenCalledWith(
      {
        providerId: 'chatgpt',
        endpoint: 'ChatGPT',
        flowId: 'flow-1',
        callbackUrl: `${REDIRECT}?code=abc&state=s1`,
      },
      expect.any(Object),
    );
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the attempt open after a paste from another attempt, so the user can paste again', async () => {
    withConnections([base]);
    mockComplete.mockImplementation((_payload, options) =>
      options?.onError?.(flowError('state_mismatch')),
    );
    render(<Connections />);
    const dialog = await openConnectDialog();

    await userEvent.type(within(dialog).getByLabelText('com_ui_connections_paste_label'), 'x');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'com_ui_connections_complete' }),
    );

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'com_ui_connections_error_state_mismatch',
    );
    expect(within(dialog).getByLabelText('com_ui_connections_paste_label')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(
      within(dialog).getByRole('button', { name: 'com_ui_connections_complete' }),
    ).toBeInTheDocument();
  });

  it('offers to start again once the attempt has expired', async () => {
    withConnections([base]);
    mockComplete.mockImplementation((_payload, options) =>
      options?.onError?.(flowError('flow_not_found')),
    );
    render(<Connections />);
    const dialog = await openConnectDialog();
    await userEvent.type(within(dialog).getByLabelText('com_ui_connections_paste_label'), 'x');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'com_ui_connections_complete' }),
    );

    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'com_ui_connections_error_flow_not_found',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'com_ui_connections_restart' }),
    );

    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  it('falls back to a generic message for an unexpected failure', async () => {
    withConnections([base]);
    mockComplete.mockImplementation((_payload, options) => options?.onError?.(new Error('boom')));
    render(<Connections />);
    const dialog = await openConnectDialog();
    await userEvent.type(within(dialog).getByLabelText('com_ui_connections_paste_label'), 'x');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'com_ui_connections_complete' }),
    );

    expect(within(dialog).getByRole('alert')).toHaveTextContent('com_ui_connections_error_generic');
  });

  it('reports a connect that cannot start', async () => {
    withConnections([base]);
    mockStart.mockImplementation((_target, options) => options?.onError?.(new Error('down')));
    render(<Connections />);

    await userEvent.click(screen.getByRole('button', { name: 'com_ui_connections_connect' }));

    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('disconnects only after the user confirms', async () => {
    withConnections([{ ...base, connected: true }]);
    const confirm = jest.spyOn(window, 'confirm');
    render(<Connections />);
    const button = screen.getByRole('button', { name: 'com_ui_connections_disconnect' });

    confirm.mockReturnValueOnce(false);
    await userEvent.click(button);
    expect(mockDisconnect).not.toHaveBeenCalled();

    confirm.mockReturnValueOnce(true);
    await userEvent.click(button);
    expect(mockDisconnect).toHaveBeenCalledWith(
      { providerId: 'chatgpt', endpoint: 'ChatGPT' },
      expect.any(Object),
    );
    confirm.mockRestore();
  });
});
