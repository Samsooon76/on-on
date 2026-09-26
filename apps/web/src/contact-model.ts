import type { Contact } from "./conversation-model";

export function editedContactPhones(contact: Contact | null, primary: string | null) {
  const others = contact?.contact_phones.slice(1) ?? [];
  return [
    ...(primary ? [{ phoneNumber: primary, label: contact?.contact_phones[0]?.label ?? "Mobile" }] : []),
    ...others.filter(phone => phone.phone_number !== primary).map(phone => ({ phoneNumber: phone.phone_number, label: phone.label })),
  ];
}
