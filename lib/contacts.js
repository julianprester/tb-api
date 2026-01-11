"use strict";

/**
 * Contacts operations using WebExtension APIs (MV3)
 * Uses messenger.addressBooks and messenger.addressBooks.contacts with vCard
 */

/**
 * Build vCard string from contact properties using ical.js
 */
function buildVCard(email, firstName, lastName, displayName) {
  const card = new ICAL.Component("vcard");
  card.addPropertyWithValue("version", "4.0");
  
  // FN (formatted name) is required
  const fn = displayName || [firstName, lastName].filter(Boolean).join(" ") || email;
  card.addPropertyWithValue("fn", fn);
  
  // N (structured name)
  if (firstName || lastName) {
    const n = card.addPropertyWithValue("n", [lastName || "", firstName || "", "", "", ""]);
  }
  
  // EMAIL
  if (email) {
    card.addPropertyWithValue("email", email);
  }
  
  return card.toString();
}

/**
 * Parse vCard string and extract properties using ical.js
 */
function parseVCard(vCardString) {
  try {
    const card = new ICAL.Component(ICAL.parse(vCardString));
    
    const fn = card.getFirstPropertyValue("fn");
    const email = card.getFirstPropertyValue("email");
    const n = card.getFirstPropertyValue("n");
    
    let firstName = null;
    let lastName = null;
    if (n && Array.isArray(n)) {
      lastName = n[0] || null;
      firstName = n[1] || null;
    }
    
    return {
      displayName: fn || null,
      email: email || null,
      firstName,
      lastName
    };
  } catch (e) {
    return { displayName: null, email: null, firstName: null, lastName: null };
  }
}

/**
 * List address books
 */
async function listAddressBooks() {
  const books = await messenger.addressBooks.list();
  return {
    addressbooks: books.map(book => ({
      id: book.id,
      name: book.name,
      readOnly: book.readOnly || false
    }))
  };
}

/**
 * Search contacts
 */
async function searchContacts(params) {
  const { q, addressbook, limit = 50 } = params;
  const maxResults = Math.min(parseInt(limit, 10) || 50, 100);

  // Use messenger.addressBooks.contacts.query() for searching (MV3)
  const queryInfo = {};
  if (q) queryInfo.searchString = q;
  if (addressbook) queryInfo.parentId = addressbook;

  let contacts = await messenger.addressBooks.contacts.query(queryInfo);

  const hasMore = contacts.length > maxResults;
  contacts = contacts.slice(0, maxResults);

  return {
    contacts: contacts.map(c => formatContact(c)),
    total: contacts.length,
    has_more: hasMore
  };
}

/**
 * Create contact
 */
async function createContact(params) {
  const { addressbook, email, firstName, lastName, displayName } = params;

  if (!addressbook) {
    return { error: "addressbook field is required" };
  }
  if (!email) {
    return { error: "email field is required" };
  }

  const vCard = buildVCard(email, firstName, lastName, displayName);

  try {
    // MV3 API: messenger.addressBooks.contacts.create(parentId, vCard)
    const id = await messenger.addressBooks.contacts.create(addressbook, vCard);
    return { success: true, message: "Contact created", id };
  } catch (e) {
    return { error: `Failed to create contact: ${e.message}` };
  }
}

/**
 * Update contact
 */
async function updateContact(contactId, params) {
  const { email, firstName, lastName, displayName } = params;

  try {
    const contact = await messenger.addressBooks.contacts.get(contactId);
    if (!contact) {
      return { error: `Contact not found: ${contactId}` };
    }

    // Parse existing vCard to get current values
    const existing = contact.vCard ? parseVCard(contact.vCard) : {};
    
    // Merge with updates
    const newEmail = email !== undefined ? email : existing.email || "";
    const newFirstName = firstName !== undefined ? firstName : existing.firstName || "";
    const newLastName = lastName !== undefined ? lastName : existing.lastName || "";
    const newDisplayName = displayName !== undefined ? displayName : existing.displayName || "";

    const vCard = buildVCard(newEmail, newFirstName, newLastName, newDisplayName);
    
    // MV3 API: messenger.addressBooks.contacts.update(id, vCard)
    await messenger.addressBooks.contacts.update(contactId, vCard);

    return { success: true, message: "Contact updated" };
  } catch (e) {
    return { error: `Failed to update contact: ${e.message}` };
  }
}

/**
 * Delete contact
 */
async function deleteContact(contactId) {
  try {
    await messenger.addressBooks.contacts.delete(contactId);
    return { success: true, message: "Contact deleted" };
  } catch (e) {
    return { error: `Failed to delete contact: ${e.message}` };
  }
}

// Helper functions

function formatContact(contact) {
  // MV3: ContactNode has vCard property instead of properties
  if (contact.vCard) {
    const parsed = parseVCard(contact.vCard);
    return {
      id: contact.id,
      addressbook: contact.parentId,
      email: parsed.email,
      displayName: parsed.displayName,
      firstName: parsed.firstName,
      lastName: parsed.lastName
    };
  }
  
  // Fallback for any remaining properties format
  const props = contact.properties || {};
  return {
    id: contact.id,
    addressbook: contact.parentId,
    email: props.PrimaryEmail || null,
    displayName: props.DisplayName || null,
    firstName: props.FirstName || null,
    lastName: props.LastName || null
  };
}

// Export
var Contacts = {
  listAddressBooks,
  searchContacts,
  createContact,
  updateContact,
  deleteContact
};
