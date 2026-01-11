"use strict";

/**
 * Contacts operations using WebExtension APIs
 */

/**
 * List address books
 */
async function listAddressBooks() {
  const books = await browser.addressBooks.list();
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

  // Use the query API for searching
  const queryInfo = {};
  if (q) queryInfo.searchString = q;
  if (addressbook) queryInfo.parentId = addressbook;

  let contacts = await browser.contacts.query(queryInfo);

  const hasMore = contacts.length > maxResults;
  contacts = contacts.slice(0, maxResults);

  return {
    contacts: contacts.map(c => formatContact(c)),
    total: contacts.length,
    has_more: hasMore
  };
}

/**
 * Build vCard string from contact properties
 */
function buildVCard(email, firstName, lastName, displayName) {
  const fn = displayName || [firstName, lastName].filter(Boolean).join(" ") || email;
  const lines = [
    "BEGIN:VCARD",
    "VERSION:4.0",
    `FN:${fn}`,
    `EMAIL:${email}`
  ];
  if (firstName || lastName) {
    lines.push(`N:${lastName || ""};${firstName || ""};;;`);
  }
  lines.push("END:VCARD");
  return lines.join("\r\n");
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
    const id = await browser.contacts.create(addressbook, vCard);
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
    const contact = await browser.contacts.get(contactId);
    if (!contact) {
      return { error: `Contact not found: ${contactId}` };
    }

    // Merge existing properties with updates
    const props = contact.properties || {};
    const newEmail = email !== undefined ? email : props.PrimaryEmail || "";
    const newFirstName = firstName !== undefined ? firstName : props.FirstName || "";
    const newLastName = lastName !== undefined ? lastName : props.LastName || "";
    const newDisplayName = displayName !== undefined ? displayName : props.DisplayName || "";

    const vCard = buildVCard(newEmail, newFirstName, newLastName, newDisplayName);
    await browser.contacts.update(contactId, vCard);

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
    await browser.contacts.delete(contactId);
    return { success: true, message: "Contact deleted" };
  } catch (e) {
    return { error: `Failed to delete contact: ${e.message}` };
  }
}

// Helper functions

function formatContact(contact) {
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
