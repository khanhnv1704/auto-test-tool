/**
 * Client-side CSS + JS shared by webview tables: drag the header's right edge to resize a column, click a
 * header to sort ascending/descending. Used by testCasesPanel.ts and reportPanel.ts.
 *
 * Usage: append `${TABLE_INTERACTIONS_STYLE}` to the page `<style>`, `${TABLE_INTERACTIONS_SCRIPT}` to the
 * end of `<script>`, then call `enableTableInteractions(table)` per `<table>`. Calling it again on the same
 * element is a no-op (guarded by `data-tbl-interactive`), which matters for tables that only swap their
 * `<tbody>` on refresh.
 */
export const TABLE_INTERACTIONS_STYLE = `
  table.tbl-interactive { table-layout: fixed; }
  table.tbl-interactive th { position: relative; box-sizing: border-box; overflow: hidden; }
  table.tbl-interactive th.col-sortable { cursor: pointer; user-select: none; }
  table.tbl-interactive th.col-sortable:hover { background: rgba(255,255,255,.06); }
  table.tbl-interactive th .sort-indicator { display: inline-block; margin-left: 4px; font-size: 10px; opacity: .35; }
  table.tbl-interactive th.sort-asc .sort-indicator,
  table.tbl-interactive th.sort-desc .sort-indicator { opacity: 1; color: #4a9eff; }
  table.tbl-interactive th .col-resize-handle {
    position: absolute; right: -3px; top: 0; bottom: 0; width: 7px; cursor: col-resize; z-index: 3;
  }
  table.tbl-interactive th .col-resize-handle:hover,
  table.tbl-interactive th .col-resize-handle.active { background: rgba(74,158,255,.5); }
  table.tbl-interactive.col-resizing { cursor: col-resize; }
  table.tbl-interactive.col-resizing * { user-select: none; }
`;

export const TABLE_INTERACTIONS_SCRIPT = `
  function enableTableInteractions(table) {
    if (!table || table.dataset.tblInteractive === '1') return;
    table.dataset.tblInteractive = '1';
    table.classList.add('tbl-interactive');

    table.querySelectorAll('thead th').forEach(function (th, colIndex) {
      // Checkbox/action columns have no text: resizable, but not sortable.
      var isSortable = th.textContent.trim().length > 0 && !th.querySelector('input');

      if (isSortable) {
        th.classList.add('col-sortable');
        var indicator = document.createElement('span');
        indicator.className = 'sort-indicator';
        indicator.textContent = '⇅';
        th.appendChild(indicator);
        th.addEventListener('click', function (e) {
          if (e.target.classList.contains('col-resize-handle')) return;
          sortTableByColumn(table, colIndex, th);
        });
      }

      var handle = document.createElement('span');
      handle.className = 'col-resize-handle';
      th.appendChild(handle);
      handle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var startX = e.pageX;
        var startWidth = th.getBoundingClientRect().width;
        handle.classList.add('active');
        table.classList.add('col-resizing');

        function onMouseMove(ev) {
          var newWidth = Math.max(36, startWidth + (ev.pageX - startX));
          th.style.width = newWidth + 'px';
        }
        function onMouseUp() {
          handle.classList.remove('active');
          table.classList.remove('col-resizing');
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
        }
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });
    });
  }

  function cellSortValue(row, colIndex) {
    var cell = row.children[colIndex];
    return cell ? cell.textContent.trim() : '';
  }

  function sortTableByColumn(table, colIndex, th) {
    var tbody = table.querySelector('tbody');
    if (!tbody) return;
    var rows = Array.prototype.slice.call(tbody.querySelectorAll('tr'));
    var newDir = th.getAttribute('data-sort-dir') === 'asc' ? 'desc' : 'asc';

    table.querySelectorAll('thead th').forEach(function (h) {
      h.removeAttribute('data-sort-dir');
      h.classList.remove('sort-asc', 'sort-desc');
      var ind = h.querySelector('.sort-indicator');
      if (ind) ind.textContent = '⇅';
    });
    th.setAttribute('data-sort-dir', newDir);
    th.classList.add(newDir === 'asc' ? 'sort-asc' : 'sort-desc');
    var indicator = th.querySelector('.sort-indicator');
    if (indicator) indicator.textContent = newDir === 'asc' ? '▲' : '▼';

    rows.sort(function (a, b) {
      var av = cellSortValue(a, colIndex);
      var bv = cellSortValue(b, colIndex);
      var an = parseFloat(av.replace(',', '.'));
      var bn = parseFloat(bv.replace(',', '.'));
      var bothNumeric = av !== '' && bv !== '' && !isNaN(an) && !isNaN(bn);
      var cmp = bothNumeric ? an - bn : av.localeCompare(bv);
      return newDir === 'asc' ? cmp : -cmp;
    });

    rows.forEach(function (r) { tbody.appendChild(r); });
  }
`;
