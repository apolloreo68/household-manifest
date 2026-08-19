import React, { useState, useEffect, useMemo } from "react";
import {
  Home, Warehouse, Plus, X, Search, User, Package, Sofa, Palette,
  UtensilsCrossed, Dumbbell, Shirt, BookOpen, Tv, Wrench, Box,
  Trash2, Edit3, Tag, Loader2, AlertCircle, Check
} from "lucide-react";
import { db } from "./firebase";
import { doc, onSnapshot, setDoc } from "firebase/firestore";

// All family data lives in a single Firestore document. Every device that
// has this app open gets pushed live updates via onSnapshot.
const MANIFEST_DOC = doc(db, "manifest", "household");

const TILE_COLORS = ["#3F6357", "#40587A", "#A67C3D", "#7A4F5A", "#5B6B3F", "#3F5A63", "#6B4F7A", "#7A5B3F"];

const uid = () => Math.random().toString(36).slice(2, 10);
const emptyData = () => ({ properties: [], people: [], categories: [], items: [] });

function categoryIcon(name = "") {
  const n = name.toLowerCase();
  if (n.includes("furnit")) return Sofa;
  if (n.includes("art")) return Palette;
  if (n.includes("kitchen") || n.includes("dish") || n.includes("cook")) return UtensilsCrossed;
  if (n.includes("sport") || n.includes("gym") || n.includes("fitness")) return Dumbbell;
  if (n.includes("cloth") || n.includes("apparel") || n.includes("linen")) return Shirt;
  if (n.includes("book") || n.includes("document")) return BookOpen;
  if (n.includes("electronic") || n.includes("tech") || n.includes("appliance")) return Tv;
  if (n.includes("tool") || n.includes("garage") || n.includes("hardware")) return Wrench;
  return Package;
}

function useDebouncedSave(data, ready) {
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => {
      setDoc(MANIFEST_DOC, data).catch((e) => console.error("save failed", e));
    }, 350);
    return () => clearTimeout(t);
  }, [data, ready]);
}

export default function App() {
  const [data, setData] = useState(emptyData());
  const [ready, setReady] = useState(false);

  // view: 'home' | 'property' | 'category'
  const [view, setView] = useState("home");
  const [selectedPropertyId, setSelectedPropertyId] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState(null); // "" means uncategorized

  const [homeSearch, setHomeSearch] = useState("");
  const [personFilter, setPersonFilter] = useState("");

  const [propertyModal, setPropertyModal] = useState(null); // { mode:'create'|'edit', property? }
  const [categoryModal, setCategoryModal] = useState(null); // { mode, category? }
  const [peopleModal, setPeopleModal] = useState(false);
  const [itemModal, setItemModal] = useState(null); // { mode, item? }
  const [confirmDelete, setConfirmDelete] = useState(null); // { type, id, label }

  useEffect(() => {
    // Live-syncs with Firestore: every family member's device that has this
    // app open will see changes from everyone else within a second or two.
    const unsubscribe = onSnapshot(
      MANIFEST_DOC,
      (snap) => {
        if (snap.exists()) setData({ ...emptyData(), ...snap.data() });
        setReady(true);
      },
      (err) => {
        console.error("listen failed", err);
        setReady(true);
      }
    );
    return () => unsubscribe();
  }, []);

  useDebouncedSave(data, ready);

  const properties = data.properties;
  const people = data.people;
  const categories = data.categories;
  const items = data.items;

  const selectedProperty = properties.find((p) => p.id === selectedPropertyId) || null;

  const itemCountForProperty = (propertyId) => items.filter((it) => it.propertyId === propertyId).length;
  const itemCountForCategory = (propertyId, cat) =>
    items.filter((it) => it.propertyId === propertyId && (it.category || "") === (cat || "")).length;

  const categoriesInProperty = useMemo(() => {
    if (!selectedPropertyId) return { list: [], hasUncategorized: false };
    const hasUncategorized = items.some((it) => it.propertyId === selectedPropertyId && !it.category);
    return { list: categories, hasUncategorized };
  }, [items, categories, selectedPropertyId]);

  const currentItems = useMemo(() => {
    if (view !== "category" || !selectedPropertyId) return [];
    return items.filter(
      (it) => it.propertyId === selectedPropertyId && (it.category || "") === (selectedCategory || "")
    );
  }, [items, view, selectedPropertyId, selectedCategory]);

  const homeSearchResults = useMemo(() => {
    if (!homeSearch.trim() && !personFilter) return null;
    const q = homeSearch.trim().toLowerCase();
    return items.filter((it) => {
      if (personFilter && it.holderId !== personFilter) return false;
      if (q) {
        const hay = [it.name, it.category, it.notes, ...(it.customFields || []).flatMap((f) => [f.key, f.value])]
          .join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, homeSearch, personFilter]);

  const personName = (id) => people.find((p) => p.id === id)?.name || null;
  const propertyName = (id) => properties.find((p) => p.id === id)?.name || "Unknown";

  /* ---- mutations ---- */
  const saveProperty = (name, type, id) => {
    setData((d) => {
      if (id) return { ...d, properties: d.properties.map((p) => (p.id === id ? { ...p, name, type } : p)) };
      return { ...d, properties: [...d.properties, { id: uid(), name, type }] };
    });
  };
  const deleteProperty = (id) => {
    setData((d) => ({
      ...d,
      properties: d.properties.filter((p) => p.id !== id),
      items: d.items.filter((it) => it.propertyId !== id),
    }));
    if (selectedPropertyId === id) { setView("home"); setSelectedPropertyId(null); }
  };

  const saveCategory = (name, oldName) => {
    setData((d) => {
      if (oldName !== undefined) {
        return {
          ...d,
          categories: d.categories.map((c) => (c === oldName ? name : c)),
          items: d.items.map((it) => (it.category === oldName ? { ...it, category: name } : it)),
        };
      }
      if (d.categories.includes(name)) return d;
      return { ...d, categories: [...d.categories, name] };
    });
  };
  const deleteCategory = (name) => {
    setData((d) => ({
      ...d,
      categories: d.categories.filter((c) => c !== name),
      items: d.items.map((it) => (it.category === name ? { ...it, category: "" } : it)),
    }));
    if (selectedCategory === name) setView("property");
  };

  const savePerson = (name, id) => {
    setData((d) => {
      if (id) return { ...d, people: d.people.map((p) => (p.id === id ? { ...p, name } : p)) };
      return { ...d, people: [...d.people, { id: uid(), name }] };
    });
  };
  const deletePerson = (id) => {
    setData((d) => ({
      ...d,
      people: d.people.filter((p) => p.id !== id),
      items: d.items.map((it) => (it.holderId === id ? { ...it, holderId: null } : it)),
    }));
  };

  const upsertItem = (item) => {
    setData((d) => ({
      ...d,
      categories: item.category && !d.categories.includes(item.category) ? [...d.categories, item.category] : d.categories,
      items: d.items.some((it) => it.id === item.id) ? d.items.map((it) => (it.id === item.id ? item : it)) : [...d.items, item],
    }));
  };
  const deleteItem = (id) => setData((d) => ({ ...d, items: d.items.filter((it) => it.id !== id) }));

  if (!ready) {
    return (
      <div style={styles.loadingScreen}>
        <Loader2 className="spin" size={28} color="#A67C3D" />
        <style>{`.spin{animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        <div style={{ marginTop: 12, fontFamily: FONT_BODY, color: "#8A8577" }}>Opening the manifest…</div>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      <GlobalStyle />

      <header style={styles.header}>
        <div style={styles.brand}>
          <div style={styles.brandMark}>⌂</div>
          <div>
            <div style={styles.brandTitle}>The Manifest</div>
            {view !== "home" && (
              <Breadcrumb
                property={selectedProperty}
                category={view === "category" ? selectedCategory : null}
                onHome={() => { setView("home"); setSelectedPropertyId(null); }}
                onProperty={() => setView("property")}
              />
            )}
          </div>
        </div>
        <div style={styles.headerActions}>
          {view === "home" && (
            <div style={styles.searchBox}>
              <Search size={14} color="#8A8577" />
              <input
                value={homeSearch}
                onChange={(e) => setHomeSearch(e.target.value)}
                placeholder="Search every item…"
                style={styles.searchInput}
              />
            </div>
          )}
          {view === "home" && (
            <select style={styles.filterSelect} value={personFilter} onChange={(e) => setPersonFilter(e.target.value)}>
              <option value="">Anyone</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <button style={styles.secondaryBtn} onClick={() => setPeopleModal(true)}>
            <User size={14} /> People
          </button>
        </div>
      </header>

      <main style={styles.main}>
        {view === "home" && homeSearchResults ? (
          <SearchResultsView
            results={homeSearchResults}
            propertyName={propertyName}
            personName={personName}
            onEdit={(it) => setItemModal({ mode: "edit", item: it })}
            onDelete={(it) => setConfirmDelete({ type: "item", id: it.id, label: it.name })}
          />
        ) : view === "home" ? (
          <HomeView
            properties={properties}
            itemCountForProperty={itemCountForProperty}
            onOpen={(id) => { setSelectedPropertyId(id); setView("property"); }}
            onEdit={(p) => setPropertyModal({ mode: "edit", property: p })}
            onDelete={(p) => setConfirmDelete({ type: "property", id: p.id, label: p.name })}
            onAdd={() => setPropertyModal({ mode: "create" })}
          />
        ) : view === "property" ? (
          <PropertyView
            property={selectedProperty}
            categories={categoriesInProperty.list}
            hasUncategorized={categoriesInProperty.hasUncategorized}
            itemCountForCategory={(cat) => itemCountForCategory(selectedPropertyId, cat)}
            onOpenCategory={(cat) => { setSelectedCategory(cat); setView("category"); }}
            onEditCategory={(cat) => setCategoryModal({ mode: "edit", category: cat })}
            onDeleteCategory={(cat) => setConfirmDelete({ type: "category", id: cat, label: cat })}
            onAddCategory={() => setCategoryModal({ mode: "create" })}
          />
        ) : (
          <CategoryView
            property={selectedProperty}
            category={selectedCategory}
            items={currentItems}
            personName={personName}
            onAddItem={() => setItemModal({ mode: "create" })}
            onEditItem={(it) => setItemModal({ mode: "edit", item: it })}
            onDeleteItem={(it) => setConfirmDelete({ type: "item", id: it.id, label: it.name })}
          />
        )}
      </main>

      {propertyModal && (
        <PropertyModal
          initial={propertyModal.property}
          onClose={() => setPropertyModal(null)}
          onSave={(name, type, id) => { saveProperty(name, type, id); setPropertyModal(null); }}
        />
      )}

      {categoryModal && (
        <CategoryModal
          initial={categoryModal.category}
          existing={categories}
          onClose={() => setCategoryModal(null)}
          onSave={(name, oldName) => { saveCategory(name, oldName); setCategoryModal(null); }}
        />
      )}

      {peopleModal && (
        <PeopleModal
          people={people}
          onClose={() => setPeopleModal(false)}
          onSave={savePerson}
          onDelete={deletePerson}
        />
      )}

      {itemModal && (
        <ItemFormModal
          item={itemModal.item}
          properties={properties}
          people={people}
          categories={categories}
          defaultPropertyId={selectedPropertyId}
          defaultCategory={view === "category" ? selectedCategory : ""}
          onClose={() => setItemModal(null)}
          onSave={(item) => { upsertItem(item); setItemModal(null); }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          label={confirmDelete.label}
          type={confirmDelete.type}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            if (confirmDelete.type === "property") deleteProperty(confirmDelete.id);
            if (confirmDelete.type === "category") deleteCategory(confirmDelete.id);
            if (confirmDelete.type === "item") deleteItem(confirmDelete.id);
            setConfirmDelete(null);
          }}
        />
      )}
    </div>
  );
}

/* ---------- Breadcrumb ---------- */
function Breadcrumb({ property, category, onHome, onProperty }) {
  return (
    <div style={styles.breadcrumb}>
      <button style={styles.crumbBtn} onClick={onHome}>All properties</button>
      {property && (
        <>
          <span style={styles.crumbSep}>/</span>
          <button style={styles.crumbBtn} onClick={onProperty}>{property.name}</button>
        </>
      )}
      {category !== null && category !== undefined && (
        <>
          <span style={styles.crumbSep}>/</span>
          <span style={styles.crumbCurrent}>{category || "Uncategorized"}</span>
        </>
      )}
    </div>
  );
}

/* ---------- Home: property grid ---------- */
function HomeView({ properties, itemCountForProperty, onOpen, onEdit, onDelete, onAdd }) {
  const houses = properties.filter((p) => p.type === "house");
  const storage = properties.filter((p) => p.type === "storage");

  if (properties.length === 0) {
    return (
      <EmptyState
        icon={<Home size={30} color="#A67C3D" />}
        title="No properties yet"
        body="Add your first house or storage spot to start the manifest."
        actionLabel="Add a property"
        onAction={onAdd}
      />
    );
  }

  return (
    <div>
      {houses.length > 0 && (
        <>
          <SectionLabel icon={<Home size={13} />} label="Houses" />
          <TileGrid>
            {houses.map((p) => (
              <PropertyTile key={p.id} property={p} colorIndex={properties.indexOf(p)}
                count={itemCountForProperty(p.id)} onOpen={() => onOpen(p.id)}
                onEdit={() => onEdit(p)} onDelete={() => onDelete(p)} />
            ))}
          </TileGrid>
        </>
      )}
      {storage.length > 0 && (
        <>
          <SectionLabel icon={<Warehouse size={13} />} label="Storage spots" />
          <TileGrid>
            {storage.map((p) => (
              <PropertyTile key={p.id} property={p} colorIndex={properties.indexOf(p)}
                count={itemCountForProperty(p.id)} onOpen={() => onOpen(p.id)}
                onEdit={() => onEdit(p)} onDelete={() => onDelete(p)} />
            ))}
          </TileGrid>
        </>
      )}
      <button style={styles.addTile} onClick={onAdd}>
        <Plus size={16} /> Add a property
      </button>
    </div>
  );
}

function SectionLabel({ icon, label }) {
  return <div style={styles.sectionLabel}>{icon}<span>{label}</span></div>;
}

function TileGrid({ children }) {
  return <div style={styles.tileGrid}>{children}</div>;
}

function PropertyTile({ property, colorIndex, count, onOpen, onEdit, onDelete }) {
  const color = TILE_COLORS[colorIndex % TILE_COLORS.length];
  const Icon = property.type === "house" ? Home : Warehouse;
  return (
    <div style={styles.tile} onClick={onOpen}>
      <div style={{ ...styles.tileIconWrap, background: color + "22", color }}>
        <Icon size={26} />
      </div>
      <div style={styles.tileName}>{property.name}</div>
      <div style={styles.tileMeta}>{count} item{count === 1 ? "" : "s"}</div>
      <div style={styles.tileActions}>
        <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onEdit(); }}><Edit3 size={13} /></button>
        <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onDelete(); }}><Trash2 size={13} /></button>
      </div>
    </div>
  );
}

/* ---------- Property view: category grid ---------- */
function PropertyView({ property, categories, hasUncategorized, itemCountForCategory, onOpenCategory, onEditCategory, onDeleteCategory, onAddCategory }) {
  return (
    <div>
      <h1 style={styles.pageTitle}>{property.name}</h1>
      <div style={styles.pageSubtitle}>Choose a category to see what's logged there</div>
      <TileGrid>
        {categories.map((cat, i) => {
          const Icon = categoryIcon(cat);
          const color = TILE_COLORS[i % TILE_COLORS.length];
          return (
            <div key={cat} style={styles.tile} onClick={() => onOpenCategory(cat)}>
              <div style={{ ...styles.tileIconWrap, background: color + "22", color }}><Icon size={26} /></div>
              <div style={styles.tileName}>{cat}</div>
              <div style={styles.tileMeta}>{itemCountForCategory(cat)} item{itemCountForCategory(cat) === 1 ? "" : "s"}</div>
              <div style={styles.tileActions}>
                <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onEditCategory(cat); }}><Edit3 size={13} /></button>
                <button style={styles.tileIconBtn} onClick={(e) => { e.stopPropagation(); onDeleteCategory(cat); }}><Trash2 size={13} /></button>
              </div>
            </div>
          );
        })}
        {hasUncategorized && (
          <div style={styles.tile} onClick={() => onOpenCategory("")}>
            <div style={{ ...styles.tileIconWrap, background: "#8A857722", color: "#8A8577" }}><Box size={26} /></div>
            <div style={styles.tileName}>Uncategorized</div>
            <div style={styles.tileMeta}>{itemCountForCategory("")} item{itemCountForCategory("") === 1 ? "" : "s"}</div>
          </div>
        )}
      </TileGrid>
      <button style={styles.addTile} onClick={onAddCategory}>
        <Plus size={16} /> Add a category
      </button>
    </div>
  );
}

/* ---------- Category view: item list ---------- */
function CategoryView({ property, category, items, personName, onAddItem, onEditItem, onDeleteItem }) {
  return (
    <div>
      <div style={styles.itemListHeader}>
        <div>
          <h1 style={styles.pageTitle}>{category || "Uncategorized"}</h1>
          <div style={styles.pageSubtitle}>{property.name} · {items.length} item{items.length === 1 ? "" : "s"}</div>
        </div>
        <button style={styles.primaryBtn} onClick={onAddItem}><Plus size={16} /> Log item</button>
      </div>
      {items.length === 0 ? (
        <EmptyState
          icon={<Package size={30} color="#A67C3D" />}
          title="Nothing logged here yet"
          body="Add the first item to this category."
          actionLabel="Log an item"
          onAction={onAddItem}
        />
      ) : (
        <div style={styles.cardGrid}>
          {items.map((it) => (
            <ItemTag key={it.id} item={it} holderName={personName(it.holderId)}
              onEdit={() => onEditItem(it)} onDelete={() => onDeleteItem(it)} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Search results (home) ---------- */
function SearchResultsView({ results, propertyName, personName, onEdit, onDelete }) {
  return (
    <div>
      <div style={styles.pageSubtitle}>{results.length} result{results.length === 1 ? "" : "s"}</div>
      {results.length === 0 ? (
        <EmptyState icon={<Search size={26} color="#A67C3D" />} title="No matches" body="Try a different search term or clear the filter." />
      ) : (
        <div style={{ ...styles.cardGrid, marginTop: 14 }}>
          {results.map((it) => (
            <ItemTag key={it.id} item={it} holderName={personName(it.holderId)}
              locationLabel={propertyName(it.propertyId)}
              onEdit={() => onEdit(it)} onDelete={() => onDelete(it)} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Item tag card ---------- */
function ItemTag({ item, holderName, locationLabel, onEdit, onDelete }) {
  return (
    <div style={styles.tagCard}>
      <div style={styles.tagHole} />
      <div style={styles.tagBody}>
        <div style={styles.tagTopRow}>
          <span style={styles.tagName}>{item.name}</span>
          <div style={styles.tagActions}>
            <button style={styles.iconBtn} onClick={onEdit} title="Edit"><Edit3 size={13} /></button>
            <button style={styles.iconBtn} onClick={onDelete} title="Remove"><Trash2 size={13} /></button>
          </div>
        </div>
        {locationLabel && (
          <div style={styles.tagCategory}><Tag size={11} /> {locationLabel}{item.category ? ` · ${item.category}` : ""}</div>
        )}
        {item.customFields?.length > 0 && (
          <div style={styles.customFieldList}>
            {item.customFields.map((f, i) => f.key ? (
              <div key={i} style={styles.customField}>
                <span style={styles.customFieldKey}>{f.key}</span>
                <span style={styles.customFieldVal}>{f.value}</span>
              </div>
            ) : null)}
          </div>
        )}
        {item.notes && <div style={styles.tagNotes}>{item.notes}</div>}
        <div style={styles.tagPerforation} />
        <div style={styles.tagStub}>
          <div style={styles.tagStubRow}><User size={12} /><span>{holderName || "In storage"}</span></div>
          <div style={styles.tagQty}>Qty: {item.quantity || 1}</div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Empty state ---------- */
function EmptyState({ icon, title, body, actionLabel, onAction }) {
  return (
    <div style={styles.emptyState}>
      <div style={styles.emptyIcon}>{icon}</div>
      <div style={styles.emptyTitle}>{title}</div>
      <div style={styles.emptyBody}>{body}</div>
      {actionLabel && <button style={styles.primaryBtn} onClick={onAction}><Plus size={15} /> {actionLabel}</button>}
    </div>
  );
}

/* ---------- Item form modal ---------- */
function ItemFormModal({ item, properties, people, categories, defaultPropertyId, defaultCategory, onClose, onSave }) {
  const [name, setName] = useState(item?.name || "");
  const [propertyId, setPropertyId] = useState(item?.propertyId || defaultPropertyId || properties[0]?.id || "");
  const [category, setCategory] = useState(item?.category ?? defaultCategory ?? "");
  const [newCategory, setNewCategory] = useState("");
  const [addingCategory, setAddingCategory] = useState(false);
  const [holderId, setHolderId] = useState(item?.holderId || "");
  const [quantity, setQuantity] = useState(item?.quantity ?? 1);
  const [notes, setNotes] = useState(item?.notes || "");
  const [customFields, setCustomFields] = useState(item?.customFields?.length ? item.customFields : [{ key: "", value: "" }]);
  const [error, setError] = useState("");

  const updateField = (i, key, value) => setCustomFields((f) => f.map((row, idx) => (idx === i ? { ...row, [key]: value } : row)));
  const addFieldRow = () => setCustomFields((f) => [...f, { key: "", value: "" }]);
  const removeFieldRow = (i) => setCustomFields((f) => f.filter((_, idx) => idx !== i));

  const handleSave = () => {
    if (!name.trim()) return setError("Give the item a name.");
    if (!propertyId) return setError("Choose a property.");
    if (addingCategory && !newCategory.trim()) return setError("Type a name for the new category, or cancel it.");
    const finalCategory = addingCategory ? newCategory.trim() : category;
    onSave({
      id: item?.id || uid(),
      name: name.trim(),
      propertyId,
      category: finalCategory,
      holderId: holderId || null,
      quantity: Math.max(1, Number(quantity) || 1),
      notes: notes.trim(),
      customFields: customFields.filter((f) => f.key.trim()),
      dateAdded: item?.dateAdded || new Date().toISOString(),
    });
  };

  return (
    <ModalShell onClose={onClose} title={item ? "Edit item" : "Log a new item"} width={520}>
      <div style={styles.formGrid}>
        <Field label="Item name">
          <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Silver plate" />
        </Field>

        <Field label="Quantity">
          <input type="number" min="1" style={{ ...styles.input, maxWidth: 120 }} value={quantity}
            onChange={(e) => setQuantity(e.target.value)} placeholder="1" />
        </Field>

        <div style={styles.formRow2}>
          <Field label="Property">
            <select style={styles.input} value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Category">
            {!addingCategory ? (
              <select style={styles.input} value={category} onChange={(e) => {
                if (e.target.value === "__new__") { setAddingCategory(true); }
                else setCategory(e.target.value);
              }}>
                <option value="">Uncategorized</option>
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                <option value="__new__">+ New category…</option>
              </select>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <input style={styles.input} value={newCategory} onChange={(e) => setNewCategory(e.target.value)}
                  placeholder="New category name" autoFocus />
                <button style={styles.iconBtn} onClick={() => { setAddingCategory(false); setNewCategory(""); }}><X size={14} /></button>
              </div>
            )}
          </Field>
        </div>

        <Field label="In the possession of">
          <select style={styles.input} value={holderId} onChange={(e) => setHolderId(e.target.value)}>
            <option value="">— In storage, no one —</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>

        <Field label="Notes">
          <textarea style={{ ...styles.input, minHeight: 56, resize: "vertical" }} value={notes}
            onChange={(e) => setNotes(e.target.value)} placeholder="Condition, value, anything worth remembering" />
        </Field>

        <div>
          <div style={styles.fieldLabel}>Custom fields</div>
          {customFields.map((f, i) => (
            <div key={i} style={styles.customFieldRow}>
              <input style={{ ...styles.input, flex: 1 }} placeholder="Field (e.g. Serial #)" value={f.key}
                onChange={(e) => updateField(i, "key", e.target.value)} />
              <input style={{ ...styles.input, flex: 1 }} placeholder="Value" value={f.value}
                onChange={(e) => updateField(i, "value", e.target.value)} />
              <button style={styles.iconBtn} onClick={() => removeFieldRow(i)}><X size={14} /></button>
            </div>
          ))}
          <button style={styles.addFieldBtn} onClick={addFieldRow}><Plus size={13} /> Add custom field</button>
        </div>

        {error && <div style={styles.formError}><AlertCircle size={14} /> {error}</div>}

        <div style={styles.formActions}>
          <button style={styles.secondaryBtn} onClick={onClose}>Cancel</button>
          <button style={styles.primaryBtn} onClick={handleSave}><Check size={15} /> {item ? "Save changes" : "Add to manifest"}</button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ---------- Property modal ---------- */
function PropertyModal({ initial, onClose, onSave }) {
  const [name, setName] = useState(initial?.name || "");
  const [type, setType] = useState(initial?.type || "house");
  const [error, setError] = useState("");
  return (
    <ModalShell onClose={onClose} title={initial ? "Edit property" : "Add a property"} width={420}>
      <div style={styles.formGrid}>
        <Field label="Name">
          <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Lake house" />
        </Field>
        <Field label="Type">
          <div style={{ display: "flex", gap: 8 }}>
            <TypeToggle active={type === "house"} icon={<Home size={14} />} label="House" onClick={() => setType("house")} />
            <TypeToggle active={type === "storage"} icon={<Warehouse size={14} />} label="Storage spot" onClick={() => setType("storage")} />
          </div>
        </Field>
        {error && <div style={styles.formError}><AlertCircle size={14} /> {error}</div>}
        <div style={styles.formActions}>
          <button style={styles.secondaryBtn} onClick={onClose}>Cancel</button>
          <button style={styles.primaryBtn} onClick={() => {
            if (!name.trim()) return setError("Give it a name.");
            onSave(name.trim(), type, initial?.id);
          }}><Check size={15} /> Save</button>
        </div>
      </div>
    </ModalShell>
  );
}

function TypeToggle({ active, icon, label, onClick }) {
  return (
    <button onClick={onClick} style={{ ...styles.typeToggle, ...(active ? styles.typeToggleActive : {}) }}>
      {icon} {label}
    </button>
  );
}

/* ---------- Category modal ---------- */
function CategoryModal({ initial, existing, onClose, onSave }) {
  const [name, setName] = useState(initial || "");
  const [error, setError] = useState("");
  return (
    <ModalShell onClose={onClose} title={initial !== undefined ? "Rename category" : "Add a category"} width={400}>
      <div style={styles.formGrid}>
        <Field label="Category name">
          <input style={styles.input} value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Furniture" />
        </Field>
        {error && <div style={styles.formError}><AlertCircle size={14} /> {error}</div>}
        <div style={styles.formActions}>
          <button style={styles.secondaryBtn} onClick={onClose}>Cancel</button>
          <button style={styles.primaryBtn} onClick={() => {
            const trimmed = name.trim();
            if (!trimmed) return setError("Give it a name.");
            if (trimmed !== initial && existing.includes(trimmed)) return setError("That category already exists.");
            onSave(trimmed, initial);
          }}><Check size={15} /> Save</button>
        </div>
      </div>
    </ModalShell>
  );
}

/* ---------- People modal ---------- */
function PeopleModal({ people, onClose, onSave, onDelete }) {
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState("");

  return (
    <ModalShell onClose={onClose} title="Family members" width={420}>
      <div style={styles.addRow}>
        <input style={{ ...styles.input, flex: 1 }} placeholder="Name" value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) { onSave(newName.trim()); setNewName(""); } }} />
        <button style={styles.secondaryBtn} onClick={() => { if (newName.trim()) { onSave(newName.trim()); setNewName(""); } }}>
          <Plus size={14} /> Add
        </button>
      </div>
      <div style={styles.manageList}>
        {people.map((p) => (
          <div key={p.id} style={styles.manageItemRow}>
            {editingId === p.id ? (
              <>
                <input style={{ ...styles.input, flex: 1 }} value={editingName} onChange={(e) => setEditingName(e.target.value)} autoFocus />
                <button style={styles.iconBtn} onClick={() => { onSave(editingName.trim() || p.name, p.id); setEditingId(null); }}><Check size={14} /></button>
                <button style={styles.iconBtn} onClick={() => setEditingId(null)}><X size={14} /></button>
              </>
            ) : (
              <>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}><User size={14} /> {p.name}</span>
                <div style={{ display: "flex", gap: 2 }}>
                  <button style={styles.iconBtn} onClick={() => { setEditingId(p.id); setEditingName(p.name); }}><Edit3 size={13} /></button>
                  <button style={styles.iconBtn} onClick={() => onDelete(p.id)}><Trash2 size={13} /></button>
                </div>
              </>
            )}
          </div>
        ))}
        {people.length === 0 && <div style={styles.sidebarEmpty}>No one added yet.</div>}
      </div>
    </ModalShell>
  );
}

/* ---------- Confirm modal ---------- */
function ConfirmModal({ label, type, onCancel, onConfirm }) {
  const noun = type === "property" ? "property" : type === "category" ? "category" : "item";
  const warning =
    type === "property" ? "This will also remove every item logged under it."
    : type === "category" ? "Items in this category will move to Uncategorized, not be deleted."
    : "This can't be undone.";
  return (
    <ModalShell onClose={onCancel} title={`Delete this ${noun}?`} width={400}>
      <p style={{ fontSize: 13.5, color: TEXT, lineHeight: 1.5 }}>
        <strong>{label}</strong> will be removed. {warning}
      </p>
      <div style={styles.formActions}>
        <button style={styles.secondaryBtn} onClick={onCancel}>Cancel</button>
        <button style={{ ...styles.primaryBtn, background: "#A64D3D" }} onClick={onConfirm}><Trash2 size={14} /> Delete</button>
      </div>
    </ModalShell>
  );
}

/* ---------- Shared bits ---------- */
function ModalShell({ children, onClose, title, width }) {
  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={{ ...styles.modal, maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <div style={styles.modalHeader}>
          <span style={styles.modalTitle}>{title}</span>
          <button style={styles.iconBtn} onClick={onClose}><X size={18} /></button>
        </div>
        <div style={styles.modalBody}>{children}</div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return <label style={styles.fieldWrap}><span style={styles.fieldLabel}>{label}</span>{children}</label>;
}

function GlobalStyle() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      body { margin: 0; }
      input, select, textarea, button { font-family: ${FONT_BODY}; }
      input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid #A67C3D; outline-offset: 1px; }
      ::placeholder { color: #A8A395; }
    `}</style>
  );
}

/* ---------- Fonts ---------- */
const FONT_DISPLAY = "'Fraunces', Georgia, serif";
const FONT_BODY = "'IBM Plex Sans', -apple-system, sans-serif";
const FONT_MONO = "'IBM Plex Mono', monospace";
const FONT_IMPORT = `@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');`;
if (typeof document !== "undefined" && !document.getElementById("manifest-fonts")) {
  const style = document.createElement("style");
  style.id = "manifest-fonts";
  style.textContent = FONT_IMPORT;
  document.head.appendChild(style);
}

const INK = "#22252A";
const PAPER = "#EAE7DD";
const PAPER_DARK = "#DFDBCE";
const BRASS = "#A67C3D";
const TEXT = "#26241E";
const MUTED = "#8A8577";
const BORDER = "#D2CDBE";

const styles = {
  app: { minHeight: "100vh", background: PAPER, color: TEXT, fontFamily: FONT_BODY },
  loadingScreen: { minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: PAPER },

  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12,
    padding: "18px 28px", borderBottom: `1px solid ${BORDER}`, background: "#F2F0E7", position: "sticky", top: 0, zIndex: 10,
  },
  brand: { display: "flex", alignItems: "center", gap: 12 },
  brandMark: { width: 34, height: 34, borderRadius: 8, background: INK, color: BRASS, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 },
  brandTitle: { fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 17, color: INK },
  breadcrumb: { display: "flex", alignItems: "center", gap: 6, fontSize: 12, marginTop: 2 },
  crumbBtn: { background: "transparent", border: "none", padding: 0, color: MUTED, cursor: "pointer", fontSize: 12, textDecoration: "underline" },
  crumbSep: { color: "#B9B4A4" },
  crumbCurrent: { color: TEXT, fontWeight: 600 },
  headerActions: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },

  searchBox: { display: "flex", alignItems: "center", gap: 6, background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 7, padding: "7px 10px", minWidth: 190 },
  searchInput: { border: "none", outline: "none", fontSize: 13, background: "transparent", width: "100%" },
  filterSelect: { border: `1px solid ${BORDER}`, borderRadius: 7, padding: "7px 8px", fontSize: 12.5, background: "#fff", color: TEXT },

  primaryBtn: { display: "flex", alignItems: "center", gap: 6, background: INK, color: "#F2EFE6", border: "none", borderRadius: 7, padding: "9px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" },
  secondaryBtn: { display: "flex", alignItems: "center", gap: 6, background: "#fff", color: TEXT, border: `1px solid ${BORDER}`, borderRadius: 7, padding: "9px 13px", fontSize: 13, cursor: "pointer" },

  main: { padding: "24px 28px 56px", maxWidth: 1100, margin: "0 auto" },
  pageTitle: { fontFamily: FONT_DISPLAY, fontSize: 25, margin: 0, fontWeight: 600, color: INK },
  pageSubtitle: { fontSize: 12.5, color: MUTED, marginTop: 4, fontFamily: FONT_MONO },

  sectionLabel: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: MUTED, margin: "18px 2px 10px" },
  tileGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 14 },
  tile: {
    position: "relative", background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 12,
    padding: "20px 14px 14px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 4,
  },
  tileIconWrap: { width: 52, height: 52, borderRadius: 12, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  tileName: { fontFamily: FONT_DISPLAY, fontWeight: 600, fontSize: 14.5, color: INK },
  tileMeta: { fontSize: 11, color: MUTED, fontFamily: FONT_MONO },
  tileActions: { position: "absolute", top: 8, right: 8, display: "flex", gap: 2 },
  tileIconBtn: { background: "#F2F0E7", border: `1px solid ${BORDER}`, borderRadius: 5, padding: 4, cursor: "pointer", color: MUTED, display: "flex" },
  addTile: {
    display: "flex", alignItems: "center", gap: 6, background: "transparent", border: `1px dashed ${BORDER}`,
    borderRadius: 10, padding: "10px 16px", fontSize: 13, color: MUTED, cursor: "pointer", marginTop: 16,
  },

  itemListHeader: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", flexWrap: "wrap", gap: 10, marginBottom: 16 },
  cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 14 },

  tagCard: { position: "relative", background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 10, boxShadow: "0 1px 2px rgba(30,25,15,0.06)" },
  tagHole: { position: "absolute", top: 12, left: 12, width: 10, height: 10, borderRadius: "50%", border: `2px solid ${BRASS}`, background: PAPER },
  tagBody: { padding: "14px 14px 12px 32px" },
  tagTopRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 6 },
  tagName: { fontFamily: FONT_DISPLAY, fontSize: 15.5, fontWeight: 600, color: INK, lineHeight: 1.25 },
  tagActions: { display: "flex", gap: 2 },
  iconBtn: { background: "transparent", border: "none", color: MUTED, cursor: "pointer", padding: 4, borderRadius: 5, display: "flex" },
  tagCategory: { display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, marginTop: 5, fontWeight: 500, color: BRASS },
  customFieldList: { marginTop: 8, display: "flex", flexDirection: "column", gap: 3 },
  customField: { display: "flex", justifyContent: "space-between", fontSize: 11.5, fontFamily: FONT_MONO, color: "#5A5648" },
  customFieldKey: { color: MUTED },
  customFieldVal: { color: TEXT },
  tagNotes: { fontSize: 12, color: "#5A5648", marginTop: 8, lineHeight: 1.4 },
  tagPerforation: { borderTop: `1px dashed ${BORDER}`, margin: "12px -14px 10px -32px" },
  tagStub: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  tagStubRow: { display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: TEXT, fontWeight: 500 },
  tagQty: { fontFamily: FONT_MONO, fontSize: 12, color: MUTED, fontWeight: 600 },

  emptyState: { display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "60px 20px", gap: 8, maxWidth: 340, margin: "20px auto" },
  emptyIcon: { width: 56, height: 56, borderRadius: "50%", background: PAPER_DARK, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 6 },
  emptyTitle: { fontFamily: FONT_DISPLAY, fontSize: 18, fontWeight: 600 },
  emptyBody: { fontSize: 13, color: MUTED, lineHeight: 1.5, marginBottom: 8 },

  modalOverlay: { position: "fixed", inset: 0, background: "rgba(20,18,12,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, zIndex: 50 },
  modal: { background: PAPER, borderRadius: 12, width: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", borderBottom: `1px solid ${BORDER}` },
  modalTitle: { fontFamily: FONT_DISPLAY, fontSize: 17, fontWeight: 600 },
  modalBody: { padding: 20, overflowY: "auto" },

  formGrid: { display: "flex", flexDirection: "column", gap: 14 },
  formRow2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  fieldWrap: { display: "flex", flexDirection: "column", gap: 5 },
  fieldLabel: { fontSize: 11.5, letterSpacing: 0.3, color: MUTED, textTransform: "uppercase", fontWeight: 600 },
  input: { border: `1px solid ${BORDER}`, borderRadius: 7, padding: "9px 11px", fontSize: 13.5, background: "#fff", color: TEXT, width: "100%" },
  customFieldRow: { display: "flex", gap: 6, marginBottom: 6, alignItems: "center" },
  addFieldBtn: { display: "flex", alignItems: "center", gap: 5, background: "transparent", border: `1px dashed ${BORDER}`, borderRadius: 6, padding: "6px 10px", fontSize: 12, color: MUTED, cursor: "pointer", marginTop: 2 },
  formError: { display: "flex", alignItems: "center", gap: 6, color: "#A64D3D", fontSize: 12.5 },
  formActions: { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 },

  typeToggle: { display: "flex", alignItems: "center", gap: 6, border: `1px solid ${BORDER}`, borderRadius: 7, padding: "8px 12px", background: "#fff", color: TEXT, cursor: "pointer", fontSize: 13 },
  typeToggleActive: { background: INK, color: "#F2EFE6", borderColor: INK },

  addRow: { display: "flex", gap: 8, marginBottom: 12 },
  manageList: { display: "flex", flexDirection: "column", gap: 6 },
  manageItemRow: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 4px", borderBottom: `1px solid ${BORDER}` },
  sidebarEmpty: { fontSize: 12, color: MUTED, padding: "6px 4px" },
};
