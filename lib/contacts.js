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

  let contacts = [];

  if (addressbook) {
    // Search specific address book
    contacts = await browser.contacts.list(addressbook);
  } else {
    // Search all address books
    const books = await browser.addressBooks.list();
    for (const book of books) {
      const bookContacts = await browser.contacts.list(book.id);
      contacts.push(...bookContacts);
    }
  }

  // Filter by query
  if (q) {
    const lower = q.toLowerCase();
    contacts = contacts.filter(c => {
      const props = c.properties || {};
      return (props.PrimaryEmail || "").toLowerCase().includes(lower) ||
             (props.DisplayName || "").toLowerCase().includes(lower) ||
             (props.FirstName || "").toLowerCase().includes(lower) ||
             (props.LastName || "").toLowerCase().includes(lower);
    });
  }

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

  // Build properties object for contacts.create(parentId, id, properties)
  // id can be null to auto-generate
  const properties = {
    PrimaryEmail: email
  };

  if (firstName) properties.FirstName = firstName;
  if (lastName) properties.LastName = lastName;
  if (displayName) {
    properties.DisplayName = displayName;
  } else if (firstName || lastName) {
    properties.DisplayName = [firstName, lastName].filter(Boolean).join(" ");
  } else {
    properties.DisplayName = email;
  }

  try {
    const id = await browser.contacts.create(addressbook, null, properties);
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

    // Build properties object with only changed fields
    const properties = {};
    if (email !== undefined) properties.PrimaryEmail = email;
    if (firstName !== undefined) properties.FirstName = firstName;
    if (lastName !== undefined) properties.LastName = lastName;
    if (displayName !== undefined) properties.DisplayName = displayName;

    await browser.contacts.update(contactId, properties);

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
