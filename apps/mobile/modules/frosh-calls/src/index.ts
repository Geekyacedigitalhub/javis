import { requireNativeModule } from "expo-modules-core";
type NativeCalls={getPermissionStatus():string;openDialer(number?:string):{accepted:boolean;message:string};requestPermission():boolean;directCall(number:string):{accepted:boolean;message:string}};
const native=requireNativeModule<NativeCalls>("FroshCalls");
export const getCallPermissionStatus=()=>native.getPermissionStatus();
export const requestCallPermission=()=>native.requestPermission();
export const openCallDialer=(number?:string)=>native.openDialer(number);
export const placeDirectCall=(number:string)=>native.directCall(number);