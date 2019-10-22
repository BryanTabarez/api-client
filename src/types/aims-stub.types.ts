import { AlChangeStamp } from './common.types';

export interface AIMSAuthentication {
  user: AIMSUser;
  account: AIMSAccount;
  token: string;
  token_expiration: number;
}

export interface AIMSUser {
  id?: string;
  name: string;
  email: string;
  linked_users: AIMSUser[];
  active?: boolean;
  locked?: boolean;
  version?: number;
  created: AlChangeStamp;
  modified: AlChangeStamp;
}

export interface AIMSAccount {
  id?: string;
  name: string;
  active: boolean;
  version?: number;
  accessible_locations: string[];
  default_location: string;
  mfa_required?: boolean;
  created: AlChangeStamp;
  modified: AlChangeStamp;
}

export interface AIMSSessionDescriptor {
  authentication: AIMSAuthentication;
  acting?: AIMSAccount;
  boundLocationId?: string;
}

