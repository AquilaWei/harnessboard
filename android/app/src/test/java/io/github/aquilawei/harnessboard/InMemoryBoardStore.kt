package io.github.aquilawei.harnessboard

/** A [BoardStore] for tests of the setup and launch logic. */
class InMemoryBoardStore : BoardStore {
    private var origin: String? = null

    override fun origin(): String? = origin

    override fun save(link: BoardLink) {
        origin = link.origin
    }

    override fun clear() {
        origin = null
    }
}
