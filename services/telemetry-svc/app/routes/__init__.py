"""Route modules.

Deliberately empty of imports: main.py mounts each router explicitly so the
import graph stays a tree. An aggregate router here would make `app.routes` a
package that imports every route module, which is how a circular import between
a route and a helper becomes possible.
"""
