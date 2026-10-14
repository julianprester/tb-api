"use strict";

/**
 * Contacts operations using WebExtension APIs (MV2)
 * Uses messenger.contacts API with properties format
 * Designed for LLM consumption with flexible inputs and helpful errors
 */

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
 * Resolve an address book through the shared resolver.
 *
 * `mode: "read"` (searchContacts) keeps fuzzy matching; `mode: "write"`
 * (createContact) requires an exact ID or name and answers ambiguous
 * references with 409 ambiguous_target. The resolved book's readOnly flag is
 * carried over for the write path's 403 check.
 */
async function resolveAddressBook(addressbook, mode) {
  const books = await messenger.addressBooks.list();

  const resolved = Utils.resolveTarget("addressbook", addressbook, {
    mode,
    candidates: books.map(book => ({ id: book.id, name: book.name })),
    hints: ["Use GET /addressbooks to see all available address books"]
  });
  if (resolved.error) return resolved;

  const book = books.find(candidate => candidate.id === resolved.id);
  return { ...resolved, readOnly: !!(book && book.readOnly) };
}

/**
 * Search contacts with flexible parameters
 */
async function searchContacts(params) {
  // Normalize parameters
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.contacts);
  const { query, addressbook, limit = 50 } = normalized;
  const parsedLimit = parseInt(limit, 10);
  const maxResults = Math.min(Math.max(parsedLimit > 0 ? parsedLimit : 50, 1), 100);

  let contacts = [];

  // Get contacts from specific address book or all
  if (addressbook) {
    const resolved = await resolveAddressBook(addressbook, "read");
    if (resolved.error) return resolved;
    contacts = await messenger.contacts.list(resolved.id);
  } else {
    const books = await messenger.addressBooks.list();

    for (const book of books) {
      const bookContacts = await messenger.contacts.list(book.id);
      contacts.push(...bookContacts);
    }
  }

  // Filter by query
  if (query) {
    const lower = query.toLowerCase();
    contacts = contacts.filter(c => {
      const props = c.properties || {};
      return (props.PrimaryEmail || "").toLowerCase().includes(lower) ||
             (props.DisplayName || "").toLowerCase().includes(lower) ||
             (props.FirstName || "").toLowerCase().includes(lower) ||
             (props.LastName || "").toLowerCase().includes(lower);
    });
  }

  // Provide helpful feedback if no results
  if (contacts.length === 0) {
    const hints = [];
    if (query) hints.push(`No contacts match "${query}"`);
    if (addressbook) hints.push("Try searching in all address books (omit addressbook parameter)");
    
    return {
      contacts: [],
      total: 0,
      has_more: false,
      hints: hints.length > 0 ? hints : ["No contacts found"]
    };
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
 * Create contact with auto-recovery and helpful errors
 */
async function createContact(params) {
  // Normalize parameters
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.contacts);
  let { addressbook, email, firstName, lastName, displayName } = normalized;

  // Auto-select the only writable address book when none was specified.
  // With several, choosing by list order silently wrote to the wrong book;
  // refuse with the same 409 "ambiguous_target" shape the shared resolver
  // uses for ambiguous write targets (and createEvent uses for calendars).
  if (addressbook === undefined || addressbook === null) {
    const books = await messenger.addressBooks.list();

    const writableBooks = books.filter(b => !b.readOnly);
    if (writableBooks.length === 0) {
      return Utils.fail("read_only", "No writable address book available", 403, [
        "All address books are read-only",
        "Use GET /addressbooks to see available address books"
      ]);
    }
    if (writableBooks.length > 1) {
      const matches = writableBooks.map(b => ({ id: b.id, name: b.name, account: null }));
      const result = Utils.fail(
        "ambiguous_target",
        "addressbook is required when multiple writable address books exist",
        409,
        [
          `Available writable address books: ${matches.map(m => `${m.name} (${m.id})`).join(", ")}`,
          "Use GET /addressbooks to see address book IDs"
        ]
      );
      result.matches = matches;
      return result;
    }
    addressbook = writableBooks[0].id;
  } else {
    // Resolve provided address book (write: exact ID/name only)
    const resolved = await resolveAddressBook(addressbook, "write");
    if (resolved.error) return resolved;
    
    if (resolved.readOnly) {
      const books = await messenger.addressBooks.list();
      const writableBooks = books.filter(b => !b.readOnly);
      return Utils.fail("read_only", `Address book "${resolved.name}" is read-only`, 403, [
        writableBooks.length > 0 
          ? `Use a writable address book: ${writableBooks.map(b => b.name).join(", ")}`
          : "No writable address books available"
      ]);
    }
    
    addressbook = resolved.id;
  }

  if (!email) {
    return Utils.fail("invalid_parameter", "Email address is required", 400, [
      'Provide an "email" field',
      'Example: POST /contacts {"email": "user@example.com", "firstName": "John", "lastName": "Doe"}'
    ]);
  }

  // Basic email validation
  if (!email.includes("@")) {
    return Utils.fail("invalid_parameter", `Invalid email address: "${email}"`, 400, ["Email must contain an @ symbol"]);
  }

  // Build properties object (MV2 format)
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
    // MV2 API: messenger.contacts.create(parentId, id, properties)
    const id = await messenger.contacts.create(addressbook, null, properties);
    return { 
      success: true, 
      message: "Contact created", 
      id,
      contact: {
        email,
        firstName: firstName || null,
        lastName: lastName || null,
        displayName: properties.DisplayName
      }
    };
  } catch (e) {
    return Utils.fail("create_failed", `Failed to create contact: ${e.message}`, 500, [
      "Check that the email address is valid",
      "Verify the address book exists and is writable"
    ]);
  }
}

/**
 * Update contact with helpful errors
 */
async function updateContact(contactId, params) {
  // Normalize parameters
  const normalized = Utils.normalizeParams(params, Utils.ALIASES.contacts);
  const { email, firstName, lastName, displayName } = normalized;

  try {
    const contact = await messenger.contacts.get(contactId);
    if (!contact) {
      return Utils.fail("not_found", `Contact not found: ${contactId}`, 404, [
        "Use GET /contacts to find the correct contact ID",
        "The contact may have been deleted"
      ]);
    }

    // Validate email if being updated
    if (email !== undefined && !email.includes("@")) {
      return Utils.fail("invalid_parameter", `Invalid email address: "${email}"`, 400, ["Email must contain an @ symbol"]);
    }

    // Build properties object with updates (MV2 format)
    const properties = {};
    if (email !== undefined) properties.PrimaryEmail = email;
    if (firstName !== undefined) properties.FirstName = firstName;
    if (lastName !== undefined) properties.LastName = lastName;
    if (displayName !== undefined) properties.DisplayName = displayName;

    // MV2 API: messenger.contacts.update(id, properties)
    await messenger.contacts.update(contactId, properties);

    return { 
      success: true, 
      message: "Contact updated",
      contact: {
        email: email !== undefined ? email : (contact.properties?.PrimaryEmail || null),
        firstName: firstName !== undefined ? firstName : (contact.properties?.FirstName || null),
        lastName: lastName !== undefined ? lastName : (contact.properties?.LastName || null),
        displayName: displayName !== undefined ? displayName : (contact.properties?.DisplayName || null)
      }
    };
  } catch (e) {
    return Utils.fail("update_failed", `Failed to update contact: ${e.message}`, 500, [
      "Check that the contact ID is correct",
      "Use GET /contacts to find the correct contact"
    ]);
  }
}

/**
 * Delete contact with helpful errors
 */
async function deleteContact(contactId) {
  try {
    // First verify contact exists
    try {
      await messenger.contacts.get(contactId);
    } catch (e) {
      return Utils.fail("not_found", `Contact not found: ${contactId}`, 404, [
        "The contact may have already been deleted",
        "Use GET /contacts to find the correct contact ID"
      ]);
    }
    
    await messenger.contacts.delete(contactId);
    return { success: true, message: "Contact deleted" };
  } catch (e) {
    return Utils.fail("delete_failed", `Failed to delete contact: ${e.message}`, 500, [
      "The contact may be in a read-only address book",
      "Check that the contact ID is correct"
    ]);
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
