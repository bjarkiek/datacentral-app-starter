export interface LegacyDcData {
  userId: number;
  userName: string;
  userDisplayName: string;
  tenancyName: string;
  tenantId: number;
  roleDisplayNames: string[];
  roleIds: number[];
  clientUrl: string;
  timeStamp: string;
  allowedGroupIds?: Array<string | number>;
  userEmail?: string;
  language?: string;
  theme?: string;
}

export interface DataCentralUserContext {
  isVerified: boolean;
  user: {
    id: string;
    userName: string;
    displayName: string;
    email?: string;
  };
  tenant: {
    id: string;
    name: string;
    clientUrl: string;
  };
  roles: string[];
  roleIds: string[];
  ui: {
    language?: string;
    theme?: string;
  };
  context: {
    allowedGroupIds?: Array<string | number>;
  };
  issuedAt?: string;
}
