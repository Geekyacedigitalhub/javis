import { requireNativeModule } from "expo-modules-core";
import type { FroshContact, FroshContactCapability } from "../../../../packages/types/src/contacts";
type NativeContacts={getPermissionStatus():string;requestPermission():boolean;search(query:string):FroshContact[]};
const native=requireNativeModule<NativeContacts>("FroshContacts");
export const getContactsCapability=():FroshContactCapability=>({available:native.getPermissionStatus()==="available",message:native.getPermissionStatus()==="available"?"Contacts access is active.":"Contacts permission is required."});
export const requestContactsPermission=()=>native.requestPermission();
export const searchContacts=(query:string)=>native.search(query);