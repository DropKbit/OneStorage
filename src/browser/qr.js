import qrcode from "qrcode-generator";
export function authenticatorQR(uri) {
  if (!uri.startsWith("otpauth://totp/") || uri.length > 1000)
    throw Error("Invalid authenticator URI");
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  return qr.createDataURL(4, 16);
}
