import { useEffect, useMemo, useState } from 'react';
import type { IDESettings, LocalProviderSettings, ProviderId, ProviderRuntimeStatus } from '@ide/protocol';

export function providerTitle(providerId: ProviderId): string {
  switch (providerId) {
    case 'opencode-go':
      return 'OpenCode Go';
    case 'custom':
      return 'Custom OpenAI';
    default:
      return providerId;
  }
}

function providerDescription(providerId: ProviderId): string {
  switch (providerId) {
    case 'opencode-go':
      return 'Curated models including Kimi, GLM, DeepSeek and more.';
    case 'custom':
      return 'Any OpenAI-compatible /v1 API endpoint.';
    default:
      return 'Provider runtime.';
  }
}

function providerBadge(provider: LocalProviderSettings): string {
  if (provider.apiKey || provider.apiKeyEnv) {
    return 'API key';
  }
  if (provider.providerId === 'custom') {
    return 'Custom';
  }
  return 'Local';
}

function providerGlyph(providerId: ProviderId): string {
  switch (providerId) {
    case 'opencode-go':
      return 'G';
    case 'custom':
      return '{}';
    default:
      return '+';
  }
}

export function ProviderSettingsPanel({
  settings,
  providerStatuses,
  isLoading,
  error,
  isSaving,
  testingProviderId,
  onSaveProvider,
  onTestProvider,
}: {
  settings?: IDESettings;
  providerStatuses: ProviderRuntimeStatus[];
  isLoading: boolean;
  error?: unknown;
  isSaving: boolean;
  testingProviderId: ProviderId | null;
  onSaveProvider: (provider: LocalProviderSettings) => Promise<void>;
  onTestProvider: (providerId: ProviderId) => Promise<void>;
}) {
  const [draftProviders, setDraftProviders] = useState<LocalProviderSettings[]>([]);
  const [connectingProviderId, setConnectingProviderId] = useState<ProviderId | null>(null);
  const [connectApiKey, setConnectApiKey] = useState('');
  const [providerSearch, setProviderSearch] = useState('');

  useEffect(() => {
    if (settings?.localProviders) {
      setDraftProviders(settings.localProviders);
    }
  }, [settings?.localProviders]);

  const statusByProvider = useMemo(
    () => new Map(providerStatuses.map((status) => [status.providerId, status])),
    [providerStatuses],
  );

  const normalizedProviderSearch = providerSearch.trim().toLowerCase();
  const visibleProviders = normalizedProviderSearch
    ? draftProviders.filter((provider) => {
      const haystack = `${providerTitle(provider.providerId)} ${providerDescription(provider.providerId)} ${provider.providerId}`.toLowerCase();
      return haystack.includes(normalizedProviderSearch);
    })
    : draftProviders;
  const enabledProviders = visibleProviders.filter((provider) => provider.enabled);
  const popularProviders = visibleProviders.filter((provider) => !provider.enabled);
  const connectingProvider = connectingProviderId ? draftProviders.find((provider) => provider.providerId === connectingProviderId) : undefined;

  const handleStartConnect = (provider: LocalProviderSettings) => {
    setConnectingProviderId(provider.providerId);
    setConnectApiKey(provider.apiKey ?? '');
  };

  const handleContinueConnect = async () => {
    if (!connectingProvider) return;
    await onSaveProvider({
      ...connectingProvider,
      enabled: true,
      apiKey: connectApiKey.trim() || connectingProvider.apiKey,
    });
    setConnectingProviderId(null);
    setConnectApiKey('');
  };

  if (isLoading) {
    return <div className="app-shell__settings-empty">Loading provider settings...</div>;
  }

  if (error) {
    return <div className="app-shell__settings-empty">Provider settings API is unavailable.</div>;
  }

  if (connectingProvider) {
    return (
      <section className="app-shell__provider-connect-view" aria-label={`Connect ${providerTitle(connectingProvider.providerId)}`}>
        <div className="app-shell__provider-connect-nav">
          <button type="button" className="app-shell__provider-back-button" aria-label="Back to providers" onClick={() => setConnectingProviderId(null)}>
            ‹
          </button>
        </div>
        <div className="app-shell__provider-connect-title">
          <div className="app-shell__provider-icon" aria-hidden="true">{providerGlyph(connectingProvider.providerId)}</div>
          <div>
            <h3>Connect {providerTitle(connectingProvider.providerId)}</h3>
            <span>{providerDescription(connectingProvider.providerId)}</span>
          </div>
        </div>
        <p>Enter your {providerTitle(connectingProvider.providerId)} API key to connect your account and use models in this IDE.</p>
        <label className="app-shell__connect-field">
          <span>{providerTitle(connectingProvider.providerId)} API key</span>
          <input
            type="password"
            value={connectApiKey}
            onChange={(event) => setConnectApiKey(event.target.value)}
            placeholder="API key"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <div className="app-shell__connect-meta">
          <span>{connectingProvider.baseUrl}</span>
          <span>{connectingProvider.models.length} models</span>
        </div>
        <button
          type="button"
          className="app-shell__connect-primary-button"
          onClick={() => void handleContinueConnect()}
          disabled={isSaving}
        >
          Continue
        </button>
      </section>
    );
  }

  return (
    <section className="app-shell__provider-settings" aria-label="Provider settings">
      <div className="app-shell__provider-search">
        <span className="app-shell__provider-search-icon" aria-hidden="true" />
        <input
          value={providerSearch}
          onChange={(event) => setProviderSearch(event.target.value)}
          placeholder="Search providers"
          spellCheck={false}
        />
      </div>
      <div className="app-shell__provider-settings-list">
        <div className="app-shell__provider-group">
          <div className="app-shell__provider-group-title">
            <span>Providers</span>
            <small>{enabledProviders.length} connected</small>
          </div>
          <div className="app-shell__provider-catalog">
            {enabledProviders.length === 0 && <div className="app-shell__provider-empty">No provider connected.</div>}
            {enabledProviders.map((provider) => {
              const status = statusByProvider.get(provider.providerId);
              const stateLabel = status?.healthy ? 'ready' : 'not ready';
              return (
                <article key={provider.providerId} className="app-shell__provider-row-card app-shell__provider-row-card--connected">
                  <div className="app-shell__provider-icon" aria-hidden="true">{providerGlyph(provider.providerId)}</div>
                  <div className="app-shell__provider-main">
                    <div className="app-shell__provider-title-row">
                      <strong>{providerTitle(provider.providerId)}</strong>
                      <span className="app-shell__provider-badge">{providerBadge(provider)}</span>
                    </div>
                    <span className={`app-shell__provider-inline-state app-shell__provider-inline-state--${stateLabel.replace(' ', '-')}`}>
                      {stateLabel}{status?.notes?.[0] ? ` · ${status.notes[0]}` : ''}
                    </span>
                    <div className="app-shell__provider-model-strip">
                      {provider.models.slice(0, 3).map((model) => <span key={model}>{model}</span>)}
                    </div>
                  </div>
                  <div className="app-shell__provider-row-actions">
                    <button
                      type="button"
                      className="app-shell__provider-link-button"
                      onClick={() => void onTestProvider(provider.providerId)}
                      disabled={testingProviderId === provider.providerId}
                    >
                      {testingProviderId === provider.providerId ? 'Testing' : 'Test'}
                    </button>
                    <button
                      type="button"
                      className="app-shell__provider-link-button"
                      onClick={() => void onSaveProvider({ ...provider, enabled: false })}
                      disabled={isSaving}
                    >
                      Disconnect
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <div className="app-shell__provider-group">
          <div className="app-shell__provider-group-title">
            <span>Popular providers</span>
            <small>{popularProviders.length} available</small>
          </div>
          <div className="app-shell__provider-catalog">
            {popularProviders.map((provider) => {
              return (
                <article key={provider.providerId} className="app-shell__provider-row-card">
                  <div className="app-shell__provider-icon" aria-hidden="true">{providerGlyph(provider.providerId)}</div>
                  <div className="app-shell__provider-main">
                    <div className="app-shell__provider-title-row">
                      <strong>{providerTitle(provider.providerId)}</strong>
                      {provider.providerId === 'opencode-go' && <span className="app-shell__provider-badge">Recommended</span>}
                    </div>
                    <span>{providerDescription(provider.providerId)}</span>
                  </div>
                  <button
                    type="button"
                    className="app-shell__provider-connect-button"
                    onClick={() => handleStartConnect(provider)}
                    disabled={isSaving}
                  >
                    <span aria-hidden="true">+</span>
                    Connect
                  </button>
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
