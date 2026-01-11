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

  // Build vCard
  const vCardLines = [
    "BEGIN:VCARD",
    "VERSION:4.0",
    `EMAIL:${email}`
  ];

  if (firstName || lastName) {
    vCardLines.push(`N:${lastName || ""};${firstName || ""};;;`);
  }
  
  const fn = displayName || [firstName, lastName].filter(Boolean).join(" ") || email;
  vCardLines.push(`FN:${fn}`);
  vCardLines.push("END:VCARD");

  const vCard = vCardLines.join("\r\n");

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

    const props = contact.properties || {};
    const newEmail = email !== undefined ? email : props.PrimaryEmail || "";
    const newFirstName = firstName !== undefined ? firstName : props.FirstName || "";
    const newLastName = lastName !== undefined ? lastName : props.LastName || "";
    const newDisplayName = displayName !== undefined ? displayName : props.DisplayName || "";

    // Build updated vCard
    const vCardLines = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      `EMAIL:${newEmail}`
    ];

    if (newFirstName || newLastName) {
      vCardLines.push(`N:${newLastName};${newFirstName};;;`);
    }

    const fn = newDisplayName || [newFirstName, newLastName].filter(Boolean).join(" ") || newEmail;
    vCardLines.push(`FN:${fn}`);
    vCardLines.push("END:VCARD");

    const vCard = vCardLines.join("\r\n");
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
