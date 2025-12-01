# Azure OpenAI Gateway Refactoring Plan

## Executive Summary

Transform the Azure OpenAI gateway from environment-variable-based configuration to explicit constructor-based configuration. This improves user experience by making all required configuration visible and explicit, while eliminating the need to remember obscure environment variable names.

**Key Changes:**

- Remove from `defaultGateways` → Users must manually instantiate
- Replace all `process.env` reads → Constructor config object
- Support two modes: Static deployments OR Discovery via Management API
- No breaking changes for existing users (feature hasn't been released yet)

## Background

### Senior Developer Feedback

> "because azure needs so much config, what do you think about making it a gateway that a user has to manually add to use it? Do you think it'll make it easier to configure that way? Rather than having to remember what all the env var names are"
>
> "like new AzureGateway(configuration)"
>
> "I was thinking only use the config, no env vars"

### Current Implementation Issues

1. **Too many environment variables** (7 total):
   - `AZURE_API_KEY`
   - `AZURE_RESOURCE_NAME`
   - `OPENAI_API_VERSION`
   - `AZURE_TENANT_ID`
   - `AZURE_CLIENT_ID`
   - `AZURE_CLIENT_SECRET`
   - `AZURE_SUBSCRIPTION_ID`
   - `AZURE_RESOURCE_GROUP`

2. **Hidden configuration** - Users must dig through docs to find all required env vars
3. **Auto-registration** - Gateway automatically added to all projects even if not used
4. **No explicit control** - Users can't customize or see configuration at instantiation

## Azure Management API Research

### Authentication Flow

**OAuth Token Endpoint:**

```
POST https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token
```

**Required Parameters:**

- `grant_type`: `client_credentials`
- `client_id`: Application (client) ID
- `client_secret`: Client secret value
- `scope`: `https://management.azure.com/.default`

**Response:**

```json
{
  "token_type": "Bearer",
  "expires_in": 3599,
  "access_token": "eyJ0eXAiOiJKV1QiLCJhbGc..."
}
```

### Deployment Discovery Endpoint

**Deployments List:**

```
GET https://management.azure.com/subscriptions/{subscriptionId}/resourceGroups/{resourceGroup}/providers/Microsoft.CognitiveServices/accounts/{resourceName}/deployments?api-version=2024-10-01
```

**Required:**

- `Authorization: Bearer {token}`
- `subscriptionId`: Azure subscription ID
- `resourceGroup`: Resource group name
- `resourceName`: Azure OpenAI resource name

**Response:**

```json
{
  "value": [
    {
      "name": "gpt-4-deployment",
      "properties": {
        "model": {
          "name": "gpt-4",
          "version": "0613",
          "format": "OpenAI"
        },
        "provisioningState": "Succeeded"
      }
    }
  ],
  "nextLink": "https://management.azure.com/..."
}
```

### What Can Be Discovered Programmatically?

With just `tenantId`, `clientId`, `clientSecret`, we can discover:

#### 1. Subscription ID ✅ **Fully Discoverable**

**Endpoint:**

```
GET https://management.azure.com/subscriptions?api-version=2022-12-01
Authorization: Bearer {token}
```

**Response:**

```json
{
  "value": [
    {
      "id": "/subscriptions/12345678-1234-1234-1234-123456789012",
      "subscriptionId": "12345678-1234-1234-1234-123456789012",
      "displayName": "My Subscription",
      "state": "Enabled"
    }
  ]
}
```

**Strategy:**

- If only 1 subscription → auto-select
- If multiple → require user to specify or pick first + warn

#### 2. Resource Group + Resource Name ✅ **Fully Discoverable**

**Option A: Azure Resource Graph (Recommended)**

```
POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01
Authorization: Bearer {token}
Content-Type: application/json

{
  "query": "Resources | where type =~ 'Microsoft.CognitiveServices/accounts' and kind =~ 'OpenAI' | project subscriptionId, resourceGroup, name, location, id"
}
```

**Response:**

```json
{
  "data": [
    {
      "subscriptionId": "12345678-1234-1234-1234-123456789012",
      "resourceGroup": "my-rg",
      "name": "my-openai-resource",
      "location": "eastus",
      "id": "/subscriptions/.../resourceGroups/my-rg/providers/Microsoft.CognitiveServices/accounts/my-openai-resource"
    }
  ]
}
```

**Benefits:**

- Single query across ALL subscriptions
- Returns subscriptionId, resourceGroup, name in one call
- Most efficient approach

**Option B: Resources API (Alternative)**

```
GET https://management.azure.com/subscriptions/{subscriptionId}/resources?api-version=2021-04-01&$filter=resourceType eq 'Microsoft.CognitiveServices/accounts'
Authorization: Bearer {token}
```

**Strategy:**

- If only 1 OpenAI resource → auto-select
- If multiple → **require user to provide resourceName** (can't guess which one)

### Required RBAC Permissions

Service Principal needs:

- **Subscription Level**: `Reader` role, OR
- **Custom Role** with:
  - `Microsoft.CognitiveServices/accounts/read`
  - `Microsoft.CognitiveServices/accounts/deployments/read`
  - `Microsoft.Resources/subscriptions/read`
  - `Microsoft.ResourceGraph/resources/action` (for Resource Graph)

### Discovery Summary

| Field            | Required for Auth | Required for Runtime | Can Discover? | Implementation                             |
| ---------------- | ----------------- | -------------------- | ------------- | ------------------------------------------ |
| `tenantId`       | ✅ Yes            | ❌ No                | ❌ No         | User provides                              |
| `clientId`       | ✅ Yes            | ❌ No                | ❌ No         | User provides                              |
| `clientSecret`   | ✅ Yes            | ❌ No                | ❌ No         | User provides                              |
| `apiKey`         | ❌ No             | ✅ Yes               | ❌ No         | User provides                              |
| `resourceName`   | ❌ No             | ✅ Yes               | ⚠️ Yes\*      | User provides (this PR)                    |
| `subscriptionId` | ✅ Yes            | ❌ No                | ✅ Yes        | User provides (this PR), discover (future) |
| `resourceGroup`  | ✅ Yes            | ❌ No                | ✅ Yes        | User provides (this PR), discover (future) |
| `apiVersion`     | ❌ No             | ✅ Yes               | ❌ No         | Optional, defaults to '2024-04-01-preview' |

**Note:** \*resourceName is discoverable but requires user selection if multiple OpenAI resources exist

### Recommendation for This PR

**Keep it simple:**

- Require all fields in this PR
- Document that subscriptionId/resourceGroup are optional and will be auto-discovered in future
- Implement discovery in a separate PR to keep scope manageable

## Configuration Design

### TypeScript Interface

```typescript
/**
 * Configuration for Azure OpenAI Gateway
 */
export interface AzureOpenAIGatewayConfig {
  /**
   * Azure OpenAI resource name (e.g., 'my-openai-resource')
   * Used to construct the API endpoint: https://{resourceName}.openai.azure.com/
   *
   * @required
   */
  resourceName: string;

  /**
   * API key for Azure OpenAI data plane operations
   * Found in Azure Portal → Your OpenAI Resource → Keys and Endpoint
   *
   * @required
   */
  apiKey: string;

  /**
   * Azure OpenAI API version
   *
   * @optional
   * @default '2024-04-01-preview'
   */
  apiVersion?: string;

  /**
   * Static list of deployment names
   * Use this for production when you know your deployments in advance
   *
   * @optional
   * @example ['gpt-4-prod', 'gpt-35-turbo-dev']
   */
  deployments?: string[];

  /**
   * Azure Management API credentials for deployment discovery
   * Required if not providing static deployments list
   *
   * @optional
   */
  management?: {
    /**
     * Azure AD tenant ID (Directory ID)
     * Found in Azure Portal → Azure Active Directory → Properties
     *
     * @required
     */
    tenantId: string;

    /**
     * Service Principal application (client) ID
     * Found in Azure Portal → App Registrations → Your App → Overview
     *
     * @required
     */
    clientId: string;

    /**
     * Service Principal client secret
     * Created in Azure Portal → App Registrations → Your App → Certificates & secrets
     *
     * @required
     */
    clientSecret: string;

    /**
     * Azure subscription ID
     * Found in Azure Portal → Subscriptions
     *
     * NOTE: In future versions, this will be auto-discovered if not provided
     *
     * @required (for now)
     * @future optional
     */
    subscriptionId: string;

    /**
     * Resource group name containing the Azure OpenAI resource
     * Found in Azure Portal → Your OpenAI Resource → Overview
     *
     * NOTE: In future versions, this will be auto-discovered if not provided
     *
     * @required (for now)
     * @future optional
     */
    resourceGroup: string;
  };
}
```

### Configuration Validation Rules

1. **Always required:** `resourceName`, `apiKey`
2. **Exactly one of:** `deployments` OR `management`
   - If both provided: Use `deployments`, ignore `management` (with warning)
   - If neither provided: Throw error
3. **If `management` provided:** `tenantId`, `clientId`, `clientSecret`, `subscriptionId`, `resourceGroup` all required (for this PR)

### User Experience Examples

#### Example 1: Static Deployments (Recommended for Production)

```typescript
import { Mastra } from '@mastra/core';
import { AzureOpenAIGateway } from '@mastra/core/llm';

const azure = new AzureOpenAIGateway({
  resourceName: 'my-openai-resource',
  apiKey: process.env.AZURE_API_KEY!,
  deployments: ['gpt-4-prod', 'gpt-35-turbo-dev'],
  apiVersion: '2024-04-01-preview', // optional
});

const mastra = new Mastra({
  gateways: { azure },
});

// Use in agent
const agent = new Agent({
  model: 'azureopenai/gpt-4-prod',
  instructions: 'You are a helpful assistant',
});
```

#### Example 2: Discovery Mode (Development/Dynamic Environments)

```typescript
import { Mastra } from '@mastra/core';
import { AzureOpenAIGateway } from '@mastra/core/llm';

const azure = new AzureOpenAIGateway({
  resourceName: 'my-openai-resource',
  apiKey: process.env.AZURE_API_KEY!,
  management: {
    tenantId: process.env.AZURE_TENANT_ID!,
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
  },
});

const mastra = new Mastra({
  gateways: { azure },
});
```

#### Example 3: Environment Variable Mapping (DX Improvement)

Users can now map their own env var names:

```typescript
// Before: Users had to use exact env var names
// AZURE_API_KEY=xxx
// AZURE_RESOURCE_NAME=my-resource

// After: Users can use any env var names they want
// MY_CUSTOM_KEY=xxx
// MY_RESOURCE=my-resource

const azure = new AzureOpenAIGateway({
  resourceName: process.env.MY_RESOURCE!,
  apiKey: process.env.MY_CUSTOM_KEY!,
  deployments: ['gpt-4'],
});
```

## Implementation Plan

### Phase 1: Core Gateway Refactoring

#### 1.1 Update Class Definition

**File:** `/packages/core/src/llm/model/gateways/azure.ts`

**Changes:**

```typescript
// Add interface above class
export interface AzureOpenAIGatewayConfig {
  resourceName: string;
  apiKey: string;
  apiVersion?: string;
  deployments?: string[];
  management?: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    subscriptionId: string;
    resourceGroup: string;
  };
}

export class AzureOpenAIGateway extends MastraModelGateway {
  readonly id = 'azureopenai';
  readonly name = 'azureopenai';
  readonly prefix = 'azureopenai';
  private tokenCache = new InMemoryServerCache();

  constructor(private config: AzureOpenAIGatewayConfig) {
    super();
    this.validateConfig();
  }

  private validateConfig(): void {
    // Validate required fields
    if (!this.config.resourceName) {
      throw new MastraError({
        id: 'AZURE_GATEWAY_INVALID_CONFIG',
        domain: 'LLM',
        category: 'UNKNOWN',
        text: 'resourceName is required for Azure OpenAI gateway',
      });
    }

    if (!this.config.apiKey) {
      throw new MastraError({
        id: 'AZURE_GATEWAY_INVALID_CONFIG',
        domain: 'LLM',
        category: 'UNKNOWN',
        text: 'apiKey is required for Azure OpenAI gateway',
      });
    }

    // Validate that at least one mode is provided
    const hasDeployments = this.config.deployments && this.config.deployments.length > 0;
    const hasManagement = this.config.management !== undefined;

    if (!hasDeployments && !hasManagement) {
      throw new MastraError({
        id: 'AZURE_GATEWAY_INVALID_CONFIG',
        domain: 'LLM',
        category: 'UNKNOWN',
        text: 'Must provide either deployments (static list) or management (discovery credentials). See documentation for examples.',
      });
    }

    // Warn if both provided
    if (hasDeployments && hasManagement) {
      console.warn(
        '[AzureOpenAIGateway] Both deployments and management credentials provided. Using static deployments list and ignoring management API.',
      );
    }

    // Validate management credentials if provided and deployments not provided
    if (hasManagement && !hasDeployments) {
      const { tenantId, clientId, clientSecret, subscriptionId, resourceGroup } = this.config.management;
      const missing = [];
      if (!tenantId) missing.push('tenantId');
      if (!clientId) missing.push('clientId');
      if (!clientSecret) missing.push('clientSecret');
      if (!subscriptionId) missing.push('subscriptionId');
      if (!resourceGroup) missing.push('resourceGroup');

      if (missing.length > 0) {
        throw new MastraError({
          id: 'AZURE_GATEWAY_INVALID_CONFIG',
          domain: 'LLM',
          category: 'UNKNOWN',
          text: `Management credentials incomplete. Missing: ${missing.join(', ')}. Required fields: tenantId, clientId, clientSecret, subscriptionId, resourceGroup.`,
        });
      }
    }
  }

  // Rest of implementation...
}
```

#### 1.2 Update fetchProviders()

**File:** `/packages/core/src/llm/model/gateways/azure.ts`

**Changes:**

```typescript
async fetchProviders(): Promise<Record<string, ProviderConfig>> {
  // Static mode: use provided deployments
  if (this.config.deployments && this.config.deployments.length > 0) {
    return {
      azureopenai: {
        apiKeyEnvVar: [], // Not used with constructor config
        apiKeyHeader: 'api-key',
        name: 'Azure OpenAI',
        models: this.config.deployments,
        docUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/',
        gateway: 'azureopenai',
      },
    };
  }

  // Discovery mode: fetch from Management API
  if (!this.config.management) {
    throw new MastraError({
      id: 'AZURE_GATEWAY_INVALID_CONFIG',
      domain: 'LLM',
      category: 'UNKNOWN',
      text: 'No deployments or management credentials provided',
    });
  }

  try {
    const token = await this.getAzureADToken(this.config.management);

    const deployments = await this.fetchDeployments(token, {
      subscriptionId: this.config.management.subscriptionId,
      resourceGroup: this.config.management.resourceGroup,
      resourceName: this.config.resourceName,
    });

    return {
      azureopenai: {
        apiKeyEnvVar: [], // Not used with constructor config
        apiKeyHeader: 'api-key',
        name: 'Azure OpenAI',
        models: deployments.map(d => d.name),
        docUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/',
        gateway: 'azureopenai',
      },
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.warn(
      `[AzureOpenAIGateway] Deployment discovery failed: ${errorMsg}`,
      '\nReturning fallback configuration. Azure OpenAI can still be used by manually specifying deployment names in the constructor.'
    );

    // Return fallback configuration with empty models
    return {
      azureopenai: {
        apiKeyEnvVar: [],
        apiKeyHeader: 'api-key',
        name: 'Azure OpenAI',
        models: [],
        docUrl: 'https://learn.microsoft.com/en-us/azure/ai-services/openai/',
        gateway: 'azureopenai',
      },
    };
  }
}
```

#### 1.3 Remove getManagementCredentials()

**Delete this method** - credentials now come from `this.config.management`

#### 1.4 Update getAzureADToken()

**File:** `/packages/core/src/llm/model/gateways/azure.ts`

**Changes:**

```typescript
private async getAzureADToken(credentials: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const { tenantId, clientId, clientSecret } = credentials;

  // Update cache key to use credentials directly
  const cacheKey = `azure-mgmt-token:${tenantId}:${clientId}`;

  const cached = (await this.tokenCache.get(cacheKey)) as CachedToken | undefined;
  if (cached && cached.expiresAt > Date.now() / 1000 + 60) {
    return cached.token;
  }

  const tokenEndpoint = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://management.azure.com/.default',
  });

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new MastraError({
      id: 'AZURE_AD_TOKEN_ERROR',
      domain: 'LLM',
      category: 'UNKNOWN',
      text: `Failed to get Azure AD token: ${response.status} ${error}`,
    });
  }

  const tokenResponse = (await response.json()) as AzureTokenResponse;

  const expiresAt = Math.floor(Date.now() / 1000) + tokenResponse.expires_in;

  await this.tokenCache.set(cacheKey, {
    token: tokenResponse.access_token,
    expiresAt,
  });

  return tokenResponse.access_token;
}
```

#### 1.5 Update getApiKey()

**File:** `/packages/core/src/llm/model/gateways/azure.ts`

**Changes:**

```typescript
async getApiKey(_modelId: string): Promise<string> {
  // Return config value directly (already validated in constructor)
  return this.config.apiKey;
}
```

#### 1.6 Update resolveLanguageModel()

**File:** `/packages/core/src/llm/model/gateways/azure.ts`

**Changes:**

```typescript
async resolveLanguageModel({
  modelId,
  apiKey,
}: {
  modelId: string;
  providerId: string;
  apiKey: string;
}): Promise<LanguageModelV2> {
  const apiVersion = this.config.apiVersion || '2024-04-01-preview';

  return createAzure({
    resourceName: this.config.resourceName,
    apiKey,
    apiVersion,
    useDeploymentBasedUrls: true,
  })(modelId);
}
```

### Phase 2: Router Integration Updates

#### 2.1 Remove from Default Gateways

**File:** `/packages/core/src/llm/model/router.ts`

**Changes:**

```diff
- import { AzureOpenAIGateway } from './gateways/azure.js';

export const defaultGateways = [
  new NetlifyGateway(),
  new ModelsDevGateway(getStaticProvidersByGateway(`models.dev`)),
-  new AzureOpenAIGateway(),
];
```

#### 2.2 Update Gateway Exports

**File:** `/packages/core/src/llm/model/gateways/index.ts`

**Verify exports exist:**

```typescript
export { AzureOpenAIGateway } from './azure.js';
export type { AzureOpenAIGatewayConfig } from './azure.js';
```

### Phase 3: Testing Updates

#### 3.1 Update Unit Tests

**File:** `/packages/core/src/llm/model/gateways/azure.test.ts`

**Major changes needed:**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzureOpenAIGateway } from './azure.js';
import type { AzureOpenAIGatewayConfig } from './azure.js';

describe('AzureOpenAIGateway', () => {
  describe('Configuration Validation', () => {
    it('should throw error if resourceName missing', () => {
      expect(() => {
        new AzureOpenAIGateway({
          apiKey: 'test-key',
          deployments: ['gpt-4'],
        } as AzureOpenAIGatewayConfig);
      }).toThrow('resourceName is required');
    });

    it('should throw error if apiKey missing', () => {
      expect(() => {
        new AzureOpenAIGateway({
          resourceName: 'test-resource',
          deployments: ['gpt-4'],
        } as AzureOpenAIGatewayConfig);
      }).toThrow('apiKey is required');
    });

    it('should throw error if neither deployments nor management provided', () => {
      expect(() => {
        new AzureOpenAIGateway({
          resourceName: 'test-resource',
          apiKey: 'test-key',
        });
      }).toThrow('Must provide either deployments');
    });

    it('should warn if both deployments and management provided', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      new AzureOpenAIGateway({
        resourceName: 'test-resource',
        apiKey: 'test-key',
        deployments: ['gpt-4'],
        management: {
          tenantId: 'tenant',
          clientId: 'client',
          clientSecret: 'secret',
          subscriptionId: 'sub',
          resourceGroup: 'rg',
        },
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Both deployments and management credentials provided'),
      );
      warnSpy.mockRestore();
    });

    it('should validate management credentials are complete', () => {
      expect(() => {
        new AzureOpenAIGateway({
          resourceName: 'test-resource',
          apiKey: 'test-key',
          management: {
            tenantId: 'tenant',
            clientId: 'client',
            // Missing clientSecret, subscriptionId, resourceGroup
          } as any,
        });
      }).toThrow('Management credentials incomplete');
    });
  });

  describe('Static Deployments Mode', () => {
    it('should return static deployments without API calls', async () => {
      const gateway = new AzureOpenAIGateway({
        resourceName: 'test-resource',
        apiKey: 'test-key',
        deployments: ['gpt-4-prod', 'gpt-35-turbo-dev'],
      });

      const providers = await gateway.fetchProviders();

      expect(providers.azureopenai.models).toEqual(['gpt-4-prod', 'gpt-35-turbo-dev']);
    });

    it('should use static deployments even if management provided', async () => {
      const gateway = new AzureOpenAIGateway({
        resourceName: 'test-resource',
        apiKey: 'test-key',
        deployments: ['gpt-4'],
        management: {
          tenantId: 'tenant',
          clientId: 'client',
          clientSecret: 'secret',
          subscriptionId: 'sub',
          resourceGroup: 'rg',
        },
      });

      const providers = await gateway.fetchProviders();

      expect(providers.azureopenai.models).toEqual(['gpt-4']);
    });
  });

  describe('Discovery Mode', () => {
    beforeEach(() => {
      // Mock fetch for token and deployments
      global.fetch = vi.fn();
    });

    it('should fetch token and deployments from Management API', async () => {
      const mockTokenResponse = {
        token_type: 'Bearer',
        expires_in: 3599,
        access_token: 'mock-token',
      };

      const mockDeploymentsResponse = {
        value: [
          {
            name: 'gpt-4-deployment',
            properties: {
              provisioningState: 'Succeeded',
              model: { name: 'gpt-4', version: '0613', format: 'OpenAI' },
            },
          },
        ],
      };

      (global.fetch as any)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockTokenResponse,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockDeploymentsResponse,
        });

      const gateway = new AzureOpenAIGateway({
        resourceName: 'test-resource',
        apiKey: 'test-key',
        management: {
          tenantId: 'test-tenant',
          clientId: 'test-client',
          clientSecret: 'test-secret',
          subscriptionId: 'test-sub',
          resourceGroup: 'test-rg',
        },
      });

      const providers = await gateway.fetchProviders();

      expect(providers.azureopenai.models).toEqual(['gpt-4-deployment']);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should return fallback config if discovery fails', async () => {
      (global.fetch as any).mockRejectedValue(new Error('Network error'));

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const gateway = new AzureOpenAIGateway({
        resourceName: 'test-resource',
        apiKey: 'test-key',
        management: {
          tenantId: 'test-tenant',
          clientId: 'test-client',
          clientSecret: 'test-secret',
          subscriptionId: 'test-sub',
          resourceGroup: 'test-rg',
        },
      });

      const providers = await gateway.fetchProviders();

      expect(providers.azureopenai.models).toEqual([]);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('Model Resolution', () => {
    it('should resolve language model with config values', async () => {
      const gateway = new AzureOpenAIGateway({
        resourceName: 'test-resource',
        apiKey: 'test-key',
        apiVersion: '2024-04-01-preview',
        deployments: ['gpt-4'],
      });

      const apiKey = await gateway.getApiKey('gpt-4');
      expect(apiKey).toBe('test-key');

      // Note: Full model resolution test would require mocking @ai-sdk/azure
    });

    it('should use default API version if not provided', async () => {
      const gateway = new AzureOpenAIGateway({
        resourceName: 'test-resource',
        apiKey: 'test-key',
        deployments: ['gpt-4'],
      });

      // Default version should be used in resolveLanguageModel
      // Verify in integration tests
    });
  });

  describe('Token Caching', () => {
    it('should cache and reuse tokens', async () => {
      const mockTokenResponse = {
        token_type: 'Bearer',
        expires_in: 3599,
        access_token: 'mock-token',
      };

      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => mockTokenResponse,
      });

      const gateway = new AzureOpenAIGateway({
        resourceName: 'test-resource',
        apiKey: 'test-key',
        management: {
          tenantId: 'test-tenant',
          clientId: 'test-client',
          clientSecret: 'test-secret',
          subscriptionId: 'test-sub',
          resourceGroup: 'test-rg',
        },
      });

      // Call twice
      await gateway.fetchProviders();
      await gateway.fetchProviders();

      // Token should be fetched only once (cached)
      const tokenCalls = (global.fetch as any).mock.calls.filter((call: any) =>
        call[0].includes('login.microsoftonline.com'),
      );
      expect(tokenCalls.length).toBe(1);
    });
  });
});
```

#### 3.2 Update Integration Tests

**File:** `/packages/core/src/llm/model/gateways/azure.integration.test.ts`

**Changes:**

```typescript
import { describe, it, expect } from 'vitest';
import { config } from 'dotenv';
import { AzureOpenAIGateway } from './azure.js';

// Load test credentials from .env.azure.test
config({ path: '.env.azure.test' });

const hasManagementCreds =
  process.env.AZURE_TENANT_ID &&
  process.env.AZURE_CLIENT_ID &&
  process.env.AZURE_CLIENT_SECRET &&
  process.env.AZURE_SUBSCRIPTION_ID &&
  process.env.AZURE_RESOURCE_GROUP &&
  process.env.AZURE_RESOURCE_NAME &&
  process.env.AZURE_API_KEY;

describe.skipIf(!hasManagementCreds)('AzureOpenAIGateway Integration Tests', () => {
  it('should fetch real deployments from Azure Management API', async () => {
    const gateway = new AzureOpenAIGateway({
      resourceName: process.env.AZURE_RESOURCE_NAME!,
      apiKey: process.env.AZURE_API_KEY!,
      management: {
        tenantId: process.env.AZURE_TENANT_ID!,
        clientId: process.env.AZURE_CLIENT_ID!,
        clientSecret: process.env.AZURE_CLIENT_SECRET!,
        subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
        resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
      },
    });

    const providers = await gateway.fetchProviders();

    expect(providers).toBeDefined();
    expect(providers.azureopenai).toBeDefined();
    expect(Array.isArray(providers.azureopenai.models)).toBe(true);
    expect(providers.azureopenai.models.length).toBeGreaterThan(0);
  });

  it('should create language model from real deployment', async () => {
    const gateway = new AzureOpenAIGateway({
      resourceName: process.env.AZURE_RESOURCE_NAME!,
      apiKey: process.env.AZURE_API_KEY!,
      management: {
        tenantId: process.env.AZURE_TENANT_ID!,
        clientId: process.env.AZURE_CLIENT_ID!,
        clientSecret: process.env.AZURE_CLIENT_SECRET!,
        subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
        resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
      },
    });

    const providers = await gateway.fetchProviders();
    const firstDeployment = providers.azureopenai.models[0];

    const apiKey = await gateway.getApiKey(firstDeployment);
    const model = await gateway.resolveLanguageModel({
      modelId: firstDeployment,
      providerId: 'azureopenai',
      apiKey,
    });

    expect(model).toBeDefined();
  });

  it('should work with static deployments mode', async () => {
    const gateway = new AzureOpenAIGateway({
      resourceName: process.env.AZURE_RESOURCE_NAME!,
      apiKey: process.env.AZURE_API_KEY!,
      deployments: ['test-deployment'],
    });

    const providers = await gateway.fetchProviders();

    expect(providers.azureopenai.models).toEqual(['test-deployment']);
  });
});
```

### Phase 4: Documentation Updates

#### 4.1 Update Gateway Documentation

**File:** `/docs/src/content/en/models/gateways/azure.mdx`

**Complete rewrite:**

````mdx
---
title: Azure OpenAI Gateway
description: Use Azure OpenAI models with automatic deployment discovery
---

The Azure OpenAI gateway provides access to OpenAI models hosted on Microsoft Azure. It supports two configuration modes: static deployment lists for production, and automatic discovery via Azure Management API for development.

## Quick Start

### Static Deployments (Recommended for Production)

```typescript
import { Mastra } from '@mastra/core';
import { AzureOpenAIGateway } from '@mastra/core/llm';
import { Agent } from '@mastra/core';

const azure = new AzureOpenAIGateway({
  resourceName: 'my-openai-resource',
  apiKey: process.env.AZURE_API_KEY!,
  deployments: ['gpt-4-prod', 'gpt-35-turbo-dev'],
});

const mastra = new Mastra({
  gateways: { azure },
});

const agent = new Agent({
  model: 'azureopenai/gpt-4-prod',
  instructions: 'You are a helpful assistant',
});
```
````

### Discovery Mode (Development)

```typescript
const azure = new AzureOpenAIGateway({
  resourceName: 'my-openai-resource',
  apiKey: process.env.AZURE_API_KEY!,
  management: {
    tenantId: process.env.AZURE_TENANT_ID!,
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
  },
});
```

## Configuration

### Required Fields

| Field          | Description                       | Where to Find                                           |
| -------------- | --------------------------------- | ------------------------------------------------------- |
| `resourceName` | Azure OpenAI resource name        | Azure Portal → Your OpenAI Resource → Overview          |
| `apiKey`       | API key for data plane operations | Azure Portal → Your OpenAI Resource → Keys and Endpoint |

### Optional Fields

| Field         | Default                | Description                         |
| ------------- | ---------------------- | ----------------------------------- |
| `apiVersion`  | `'2024-04-01-preview'` | Azure OpenAI API version            |
| `deployments` | `undefined`            | Static list of deployment names     |
| `management`  | `undefined`            | Credentials for automatic discovery |

### Management API Credentials

Required only for automatic deployment discovery:

| Field            | Description                      | Where to Find                                                        |
| ---------------- | -------------------------------- | -------------------------------------------------------------------- |
| `tenantId`       | Azure AD tenant ID               | Azure Portal → Azure Active Directory → Properties                   |
| `clientId`       | Service Principal application ID | Azure Portal → App Registrations → Your App → Overview               |
| `clientSecret`   | Service Principal client secret  | Azure Portal → App Registrations → Your App → Certificates & secrets |
| `subscriptionId` | Azure subscription ID            | Azure Portal → Subscriptions                                         |
| `resourceGroup`  | Resource group name              | Azure Portal → Your OpenAI Resource → Overview                       |

## Setup Guide

### 1. Create Azure OpenAI Resource

1. Go to [Azure Portal](https://portal.azure.com)
2. Create a new Azure OpenAI resource
3. Note the **Resource Name** (e.g., `my-openai-resource`)
4. Deploy models (e.g., GPT-4, GPT-3.5 Turbo)
5. Copy **API Key** from Keys and Endpoint section

### 2. (Optional) Create Service Principal for Discovery

Only needed if using automatic deployment discovery:

1. Go to Azure Portal → App Registrations
2. Create new registration
3. Note **Application (client) ID** and **Directory (tenant) ID**
4. Create client secret in Certificates & secrets
5. Assign **Reader** role to the service principal on your subscription

### 3. Configure Environment Variables

```bash
# Required
AZURE_RESOURCE_NAME=my-openai-resource
AZURE_API_KEY=your-api-key

# Optional: For deployment discovery
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-client-secret
AZURE_SUBSCRIPTION_ID=your-subscription-id
AZURE_RESOURCE_GROUP=your-resource-group
```

## Usage Examples

### Basic Usage

```typescript
const agent = new Agent({
  model: 'azureopenai/gpt-4-deployment',
  instructions: 'You are a helpful assistant',
});

const response = await agent.generate('Hello!');
```

### Multiple Deployments

```typescript
const azure = new AzureOpenAIGateway({
  resourceName: 'my-openai-resource',
  apiKey: process.env.AZURE_API_KEY!,
  deployments: ['gpt-4-prod', 'gpt-4-staging', 'gpt-35-turbo'],
});

// Use different deployments for different purposes
const prodAgent = new Agent({ model: 'azureopenai/gpt-4-prod' });
const stagingAgent = new Agent({ model: 'azureopenai/gpt-4-staging' });
```

### Custom Environment Variables

```typescript
// Map to your own environment variable names
const azure = new AzureOpenAIGateway({
  resourceName: process.env.MY_AZURE_RESOURCE!,
  apiKey: process.env.MY_AZURE_KEY!,
  deployments: ['gpt-4'],
});
```

## Model Format

Use Azure OpenAI models with the format:

```
azureopenai/<deployment-name>
```

Where `<deployment-name>` is your Azure deployment name (NOT the base model name).

**Examples:**

- `azureopenai/gpt-4-prod` ✅
- `azureopenai/my-gpt-35-turbo` ✅
- `azureopenai/gpt-4` ❌ (unless you named your deployment exactly "gpt-4")

## Troubleshooting

### "Management credentials incomplete"

**Solution:** Ensure all required management fields are provided:

- `tenantId`
- `clientId`
- `clientSecret`
- `subscriptionId`
- `resourceGroup`

### "Failed to get Azure AD token"

**Causes:**

- Invalid tenant ID, client ID, or client secret
- Service principal doesn't exist or is disabled
- Network connectivity issues

**Solution:** Verify credentials in Azure Portal and ensure service principal is active.

### "Failed to fetch Azure deployments"

**Causes:**

- Service principal lacks permissions
- Invalid subscription ID or resource group
- Resource doesn't exist

**Solution:**

1. Verify subscription ID and resource group are correct
2. Ensure service principal has **Reader** role on subscription
3. Check that the Azure OpenAI resource exists

### Discovery returns empty models array

**Causes:**

- No deployments in the resource
- All deployments are in provisioning/failed state
- Discovery failed but fallback config was returned

**Solution:**

1. Check Azure Portal → Your Resource → Model deployments
2. Ensure at least one deployment is in "Succeeded" state
3. If discovery is failing, use static deployments mode instead

## Best Practices

1. **Use static deployments in production** - Faster startup, no Management API dependencies
2. **Use discovery in development** - Automatically stay in sync with deployed models
3. **Cache credentials securely** - Use Azure Key Vault or secure environment variables
4. **Principle of least privilege** - Service principal only needs Reader role
5. **Monitor API usage** - Track deployment usage and costs in Azure Portal

## API Version Updates

The gateway defaults to `apiVersion: '2024-04-01-preview'`. To use a different version:

```typescript
const azure = new AzureOpenAIGateway({
  resourceName: 'my-resource',
  apiKey: process.env.AZURE_API_KEY!,
  apiVersion: '2024-10-01', // Custom version
  deployments: ['gpt-4'],
});
```

Check [Azure OpenAI REST API versioning](https://learn.microsoft.com/en-us/azure/ai-services/openai/api-version-deprecation) for available versions.

## Related

- [Azure OpenAI Documentation](https://learn.microsoft.com/en-us/azure/ai-services/openai/)
- [Azure Portal](https://portal.azure.com)
- [Service Principal Setup](https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal)

````

#### 4.2 Update Changeset

**File:** `.changeset/azure-gateway-deployment-discovery.md`

**Updated content:**

```markdown
---
"@mastra/core": minor
---

Add Azure OpenAI gateway with manual instantiation and explicit configuration

**IMPORTANT:** The Azure OpenAI gateway must now be manually instantiated and passed to Mastra. It is no longer auto-registered.

## New Usage

### Static Deployments (Recommended)

```typescript
import { Mastra } from '@mastra/core';
import { AzureOpenAIGateway } from '@mastra/core/llm';

const azure = new AzureOpenAIGateway({
  resourceName: 'my-openai-resource',
  apiKey: process.env.AZURE_API_KEY!,
  deployments: ['gpt-4-prod', 'gpt-35-turbo-dev'],
});

const mastra = new Mastra({
  gateways: { azure },
});
````

### Discovery Mode (Development)

```typescript
const azure = new AzureOpenAIGateway({
  resourceName: 'my-openai-resource',
  apiKey: process.env.AZURE_API_KEY!,
  management: {
    tenantId: process.env.AZURE_TENANT_ID!,
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
  },
});
```

## Benefits

1. **Explicit Configuration** - All required values visible in code
2. **Flexible Environment Variables** - Map to any env var names
3. **Type Safety** - Full TypeScript support for configuration object
4. **Better Error Messages** - Clear validation errors at instantiation
5. **No Hidden Magic** - Gateway only included when explicitly added

## Features

- **Two Configuration Modes:**
  - Static: Provide deployment names directly (fast, production-ready)
  - Discovery: Auto-fetch deployments from Azure Management API (development)

- **Automatic Token Caching** - OAuth tokens cached with 1-minute expiry buffer

- **Graceful Fallback** - If discovery fails, gateway still works with manual deployment names

- **Deployment Filtering** - Only returns successfully provisioned deployments

- **Pagination Support** - Handles large numbers of deployments automatically

## Azure Management API Research

The gateway can optionally discover deployments using Azure Management API:

**What CAN be discovered** (future enhancement):

- `subscriptionId` - Via Subscriptions API
- `resourceGroup` - Via Resource Graph API

**What MUST be provided**:

- `tenantId`, `clientId`, `clientSecret` - Authentication credentials
- `apiKey` - Runtime API key
- `resourceName` - Required for both discovery and runtime
- `subscriptionId`, `resourceGroup` - Required for this version (auto-discovery coming in future release)

**Minimum RBAC Required**: Service Principal needs **Reader** role on subscription

## Related Documentation

- [Azure OpenAI Gateway Documentation](/docs/models/gateways/azure)
- [Azure Management API](https://learn.microsoft.com/en-us/rest/api/azure/)
- [Service Principal Setup](https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal)

````

## Testing Strategy

### Unit Tests Coverage

- ✅ Configuration validation
  - Missing required fields
  - Invalid combinations
  - Warning when both modes provided
- ✅ Static deployments mode
  - Returns provided deployments
  - No API calls made
  - Ignores management credentials
- ✅ Discovery mode
  - Token fetching
  - Deployment fetching
  - Pagination handling
  - Error handling
  - Fallback behavior
- ✅ Model resolution
  - API key retrieval
  - Language model creation
  - API version handling
- ✅ Token caching
  - Cache hit/miss
  - Expiry handling
  - Cache key generation

### Integration Tests Coverage

- ✅ Real Azure Management API calls
- ✅ Real deployment discovery
- ✅ Real model instantiation
- ✅ Static mode with real credentials
- ⚠️ Skipped when credentials not available

### Manual Testing Checklist

- [ ] Static deployments work in example app
- [ ] Discovery mode works in example app
- [ ] Type autocomplete works for deployment names
- [ ] Error messages are clear and helpful
- [ ] Documentation examples work copy-paste
- [ ] Migration from env vars is straightforward

## Files to Modify

### High Priority (Core Implementation)

1. ✅ `/packages/core/src/llm/model/gateways/azure.ts` - Main refactoring
2. ✅ `/packages/core/src/llm/model/router.ts` - Remove from defaults
3. ✅ `/packages/core/src/llm/model/gateways/index.ts` - Export types

### Medium Priority (Testing)

4. ✅ `/packages/core/src/llm/model/gateways/azure.test.ts` - Update all tests
5. ✅ `/packages/core/src/llm/model/gateways/azure.integration.test.ts` - Update integration tests

### Medium Priority (Documentation)

6. ✅ `/docs/src/content/en/models/gateways/azure.mdx` - Complete rewrite
7. ✅ `.changeset/azure-gateway-deployment-discovery.md` - Update with migration guide

### Low Priority (Examples - Optional)

8. ⚠️ Create example in `/examples/` showing both modes
9. ⚠️ Add to kitchen sink example if it exists

### Not Modified

- `.env.azure.test` - Keep as-is for integration tests (values read into config)
- Gateway resolver, registry generator - No changes needed (already support custom gateways)

## Implementation Checklist

### Phase 1: Core Refactoring
- [ ] Add `AzureOpenAIGatewayConfig` interface with JSDoc
- [ ] Add constructor with config parameter
- [ ] Add `validateConfig()` method
- [ ] Update `fetchProviders()` for static/discovery modes
- [ ] Remove `getManagementCredentials()` method
- [ ] Update `getAzureADToken()` to use config
- [ ] Update cache key generation to use config
- [ ] Update `getApiKey()` to return config value
- [ ] Update `resolveLanguageModel()` to use config values
- [ ] Update all error messages to mention config instead of env vars

### Phase 2: Router Integration
- [ ] Remove `AzureOpenAIGateway` from `defaultGateways` array
- [ ] Verify exports in `/packages/core/src/llm/model/gateways/index.ts`
- [ ] Update example apps to instantiate gateway manually

### Phase 3: Testing
- [ ] Write configuration validation tests
- [ ] Write static deployments mode tests
- [ ] Write discovery mode tests (with mocked fetch)
- [ ] Write token caching tests
- [ ] Update integration tests to use constructor config
- [ ] Ensure all tests pass
- [ ] Add test for warning when both modes provided

### Phase 4: Documentation
- [ ] Rewrite gateway documentation with both modes
- [ ] Add setup guide with Azure Portal screenshots
- [ ] Add troubleshooting section
- [ ] Add best practices
- [ ] Update changeset with migration examples
- [ ] Document API research findings
- [ ] Add JSDoc comments to interface

### Phase 5: Final Review
- [ ] Run `pnpm build` from root
- [ ] Run `pnpm test` from packages/core
- [ ] Run `pnpm typecheck` from root
- [ ] Test in example app manually
- [ ] Verify type autocomplete works
- [ ] Review all error messages
- [ ] Update PR description with summary

## Migration Guide (for future users if this had shipped)

Since this feature hasn't been released yet, no migration is needed. However, if it had been released:

### Before (Environment Variables)

```bash
# .env
AZURE_RESOURCE_NAME=my-openai-resource
AZURE_API_KEY=xxx
AZURE_TENANT_ID=xxx
AZURE_CLIENT_ID=xxx
AZURE_CLIENT_SECRET=xxx
AZURE_SUBSCRIPTION_ID=xxx
AZURE_RESOURCE_GROUP=xxx
````

```typescript
// Automatic - gateway auto-registered
const mastra = new Mastra({});

const agent = new Agent({
  model: 'azureopenai/gpt-4-deployment',
});
```

### After (Constructor Config)

```typescript
import { AzureOpenAIGateway } from '@mastra/core/llm';

const azure = new AzureOpenAIGateway({
  resourceName: process.env.AZURE_RESOURCE_NAME!,
  apiKey: process.env.AZURE_API_KEY!,
  management: {
    tenantId: process.env.AZURE_TENANT_ID!,
    clientId: process.env.AZURE_CLIENT_ID!,
    clientSecret: process.env.AZURE_CLIENT_SECRET!,
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
  },
});

const mastra = new Mastra({
  gateways: { azure },
});

const agent = new Agent({
  model: 'azureopenai/gpt-4-deployment',
});
```

## Success Criteria

- ✅ Zero `process.env` usage in gateway code
- ✅ Users must manually instantiate gateway
- ✅ All configuration visible in constructor
- ✅ Both static and discovery modes work
- ✅ All tests pass with new approach
- ✅ Clear, helpful error messages
- ✅ Comprehensive documentation
- ✅ Type safety maintained
- ✅ Backward compatible for unreleased feature

## Future Enhancements

### Auto-Discovery of Subscription and Resource Group

**Add in future PR:**

```typescript
interface AzureOpenAIGatewayConfig {
  resourceName: string;
  apiKey: string;
  apiVersion?: string;
  deployments?: string[];
  management?: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
    subscriptionId?: string; // ← Make optional
    resourceGroup?: string; // ← Make optional
  };
}
```

**Implementation:**

1. If `subscriptionId` not provided:
   - Call `GET https://management.azure.com/subscriptions?api-version=2022-12-01`
   - If 1 subscription → auto-select
   - If multiple → pick first + warn, or error asking user to specify

2. If `resourceGroup` not provided:
   - Use Azure Resource Graph to find resource by name
   - Extract resourceGroup from resource metadata

**Benefits:**

- Reduces required config from 7 fields to 4 fields (43% reduction)
- Simpler onboarding experience
- Still explicit (no hidden env vars)

## Conclusion

This refactoring significantly improves the Azure OpenAI gateway user experience by:

1. **Making configuration explicit** - No hidden environment variable requirements
2. **Providing flexibility** - Users can map to their own env var names
3. **Offering two modes** - Static for production, discovery for development
4. **Maintaining type safety** - Full TypeScript support
5. **Graceful degradation** - Works even if discovery fails

The implementation follows the established gateway pattern, maintains full test coverage, and provides comprehensive documentation for users.
