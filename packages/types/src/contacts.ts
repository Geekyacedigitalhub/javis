export interface FroshContactPhone { label?: string; number: string; }
export interface FroshContact { id: string; name: string; phones: FroshContactPhone[]; }
export interface FroshContactCapability { available: boolean; message?: string; }
