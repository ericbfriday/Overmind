import {Colony, getAllColonies} from '../Colony';
import {log} from '../console/log';
import {Pathing} from '../movement/Pathing';
import {Overlord} from '../overlords/Overlord';
import {profile} from '../profiler/decorator';
import {equalXYR, getPosFromString, randomHex, toColumns} from '../utilities/utils';
import {NotifierPriority} from './Notifier';

interface DirectiveCreationOptions {
	memory?: FlagMemory;
	name?: string;
	quiet?: boolean;
}

const DEFAULT_MAX_PATH_LENGTH = 600;
const DEFAULT_MAX_LINEAR_RANGE = 10;

/**
 * Directives are contextual wrappers for flags and serve as attachment points for Overlords, acting as a sort of
 * "process table" for the bot, with individual processes (Overlords) run by the scheulder (Overseer)
 */
@profile
export abstract class Directive {

	static directiveName: string;				// Name of the type of directive, e.g. "incubate"
	static color: ColorConstant; 				// Flag color
	static secondaryColor: ColorConstant;		// Flag secondaryColor

	name: string;								// The name of the flag
	ref: string;								// Also the name of the flag; used for task targeting
	colony: Colony; 							// The colony of the directive (directive is removed if undefined)
	colonyFilter?: (colony: Colony) => boolean; // Requirements to assign to a colony
	pos: RoomPosition; 							// Flag position
	room: Room | undefined;						// Flag room
	memory: FlagMemory;							// Flag memory
	overlords: { [name: string]: Overlord };	// Overlords
	waypoints?: RoomPosition[];					// List of portals to travel through to reach destination

	constructor(flag: Flag, colonyFilter?: (colony: Colony) => boolean) {

		this.memory = flag.memory;
		this.name = flag.name;
		this.ref = flag.ref;

		if (this.memory.suspendUntil) {
			if (Game.time < this.memory.suspendUntil) {
				return;
			} else {
				delete this.memory.suspendUntil;
			}
		}

		// Register creation tick
		if (!this.memory[MEM.TICK]) {
			this.memory[MEM.TICK] = Game.time;
		}
		// Delete the directive if expired
		if (this.memory[MEM.EXPIRATION] && !this.memory.persistent && Game.time > this.memory[MEM.EXPIRATION]!) {
			log.alert(`Removing expired directive ${this.print}!`);
			flag.remove();
			return;
		}

		if (this.memory.waypoints) {
			this.waypoints = _.map(this.memory.waypoints, posName => getPosFromString(posName)!);
		}

		// Relocate flag if needed; this must be called before the colony calculations
		if (this.memory.setPos) {
			const setPosition = derefRoomPosition(this.memory.setPos);
			if (!this.flag.pos.isEqualTo(setPosition)) {
				this.flag.setPosition(setPosition);
			} else {
				delete this.memory.setPos;
			}
			this.pos = setPosition;
			this.room = Game.rooms[setPosition.roomName];
		} else {
			this.pos = flag.pos;
			this.room = flag.room;
		}

		// Handle colony assigning
		const colony = this.getColony(colonyFilter);
		// Delete the directive if the colony is dead
		if (!colony) {
			if (Overmind.exceptions.length == 0) {
				log.alert(`Could not get colony for directive ${this.print}; removing flag!`);
				flag.remove();
			} else {
				log.alert(`Could not get colony for directive ${this.print}; ` +
						  `exceptions present this tick, so won't remove`);
			}
			return;
		}

		// Register colony and add flags to colony.flags
		this.colony = colony;
		this.colony.flags.push(flag);
		this.overlords = {};
		// Register directive on Overmind
		global[this.name] = this;
		Overmind.overseer.registerDirective(this);
		Overmind.directives[this.name] = this;
	}

	get print(): string {
		return '<a href="#!/room/' + Game.shard.name + '/' + this.pos.roomName + '">[' + this.name + ']</a>';
	}

	debug(...args: any[]) {
		if (this.memory.debug) {
			log.alert(this.print, args);
		}
	}

	private info(): string {
		let msg: string =
				`Info for ${this.print}: —————————————————————————————————————————————————————————————————————————`;
		const info1 = {
			'Type:'  : this.directiveName,
			'Name:'  : this.name,
			'Pos:'   : this.pos.print,
			'Colony:': this.colony.print,
		};
		msg += toColumns(info1).join('\n');
		msg += `Overlords: \n`;
		const tab = `  `;
		for (const overlordName in this.overlords) {
			msg += tab + `${overlordName}:\n`;
			const olInfo: { [left: string]: string } = {};
			const overlord = this.overlords[overlordName] as any;
			olInfo[tab + tab + 'Creep usage:'] = JSON.stringify(overlord.creepUsageReport);
			olInfo[tab + tab + 'Zerg:'] = _.mapValues(overlord._zerg,
													  zergOfRole => _.map(zergOfRole, (zerg: any) => zerg.print));
			olInfo[tab + tab + 'CombatZerg:'] = _.mapValues(overlord._combatZerg,
															zergOfRole => _.map(zergOfRole, (zerg: any) => zerg.print));
			msg += toColumns(olInfo).join('\n');
		}
		msg += 'Memory:\n' + print(this.memory);
		return msg;
	}

	/**
	 * Gets an effective room position for a directive; allows you to reference this.pos in constructor super() without
	 * throwing an error
	 */
	static getPos(flag: Flag): RoomPosition {
		if (flag.memory && flag.memory.setPos) {
			const pos = derefRoomPosition(flag.memory.setPos);
			return pos;
		}
		return flag.pos;
	}

	// Flag must be a getter to avoid caching issues
	get flag(): Flag {
		return Game.flags[this.name];
	}

	// This allows you to access static DirectiveClass.directiveName from an instance of DirectiveClass
	get directiveName(): string {
		return (<any>this.constructor).directiveName;
	}

	refresh(): void {
		const flag = this.flag;
		if (!flag) {
			log.warning(`Missing flag for directive ${this.print}! Removing directive.`);
			this.remove();
			return;
		}
		this.memory = flag.memory;
		this.pos = flag.pos;
		this.room = flag.room;
	}

	alert(message: string, priority = NotifierPriority.Normal): void {
		Overmind.overseer.notifier.alert(message, this.pos.roomName, priority);
	}

	private handleRelocation(): boolean {
		if (this.memory.setPos) {
			const pos = derefRoomPosition(this.memory.setPos);
			if (!this.flag.pos.isEqualTo(pos)) {
				const result = this.flag.setPosition(pos);
				if (result == OK) {
					log.debug(`Moving ${this.name} from ${this.flag.pos.print} to ${pos.print}.`);
				} else {
					log.warning(`Could not set room position to ${JSON.stringify(this.memory.setPos)}!`);
				}
			} else {
				delete this.memory.setPos;
			}
			this.pos = pos;
			this.room = Game.rooms[pos.roomName];
			return true;
		}
		return false;
	}

	/**
	 * Computes the parent colony for the directive to be handled by
	 */
	private getColony(colonyFilter?: (colony: Colony) => boolean): Colony | undefined {
		// If something is written to flag.colony, use that as the colony
		if (this.memory[MEM.COLONY]) {
			return Overmind.colonies[this.memory[MEM.COLONY]!];
		} else {

			// If flag contains a colony name as a substring, assign to that colony, regardless of RCL
			const colonyNames = _.keys(Overmind.colonies);
			for (const name of colonyNames) {
				if (this.name.includes(name)) {
					if (this.name.split(name)[1] != '') continue; // in case of other substring, e.g. E11S12 and E11S1
					this.memory[MEM.COLONY] = name;
					return Overmind.colonies[name];
				}
			}

			// If flag is in a room belonging to a colony and the colony has sufficient RCL, assign to there
			const colony = Overmind.colonies[Overmind.colonyMap[this.pos.roomName]] as Colony | undefined;
			if (colony) {
				if (!colonyFilter || colonyFilter(colony)) {
					this.memory[MEM.COLONY] = colony.name;
					return colony;
				}
			}

			// Otherwise assign to closest colony
			const maxPathLength = this.memory.maxPathLength || DEFAULT_MAX_PATH_LENGTH;
			const maxLinearRange = this.memory.maxLinearRange || DEFAULT_MAX_LINEAR_RANGE;
			this.debug(`Recalculating colony association for ${this.name} in ${this.pos.roomName}`);

			let nearestColony: Colony | undefined;
			let minDistance = Infinity;
			for (const colony of getAllColonies()) {
				if (Game.map.getRoomLinearDistance(this.pos.roomName, colony.name) > maxLinearRange
					&& !this.memory.allowPortals) {
					continue;
				}
				if (!colonyFilter || colonyFilter(colony)) {
					const ret = Pathing.findPath((colony.hatchery || colony).pos, this.pos);
					// TODO handle directives that can't find a path at great range
					if (!ret.incomplete) {
						if (ret.path.length < maxPathLength && ret.path.length < minDistance) {
							nearestColony = colony;
							minDistance = ret.path.length;
						}
						this.debug(`Path length to ${colony.room.print}: ${ret.path.length}`);
					} else {
						this.debug(`Incomplete path from ${colony.room.print}`);
					}
				}
			}

			if (nearestColony) {
				log.info(`Colony ${nearestColony.room.print} assigned to ${this.name}.`);
				this.memory[MEM.COLONY] = nearestColony.room.name;
				return nearestColony;
			} else {
				log.error(`Could not find colony match for ${this.name} in ${this.pos.roomName}! ` +
						  `Try setting memory.maxPathLength and memory.maxLinearRange.`);
			}

		}
	}

	// Wrapped flag methods ============================================================================================
	remove(force = false): OK | undefined {
		if (!this.memory.persistent || force) {
			delete Overmind.directives[this.name];
			delete global[this];
			Overmind.overseer.removeDirective(this);
			if (this.colony) {
				_.remove(this.colony.flags, flag => flag.name == this.name);
			}
			if (this.flag) { // check in case flag was removed manually in last build cycle
				return this.flag.remove();
			}
		}
	}

	setColor(color: ColorConstant, secondaryColor?: ColorConstant): number {
		if (secondaryColor) {
			return this.flag.setColor(color, secondaryColor);
		} else {
			return this.flag.setColor(color);
		}
	}

	setPosition(pos: RoomPosition): number {
		// Ignore the (x,y) setPosition option since I never use it
		return this.flag.setPosition(pos);
	}

	// Custom directive methods ========================================================================================

	/* Create an appropriate flag to instantiate this directive in the next tick */
	static create(pos: RoomPosition, opts: DirectiveCreationOptions = {}): number | string {
		let flagName = opts.name || undefined;
		if (!flagName) {
			flagName = this.directiveName + ':' + randomHex(6);
			if (Game.flags[flagName]) {
				return ERR_NAME_EXISTS;
			}
		}
		if (!opts.quiet) {
			log.alert(`Creating ${this.directiveName} directive at ${pos.print}!`);
		}
		const result = pos.createFlag(flagName, this.color, this.secondaryColor) as string | number;
		if (result == flagName && opts.memory) {
			Memory.flags[flagName] = opts.memory;
		}
		log.debug(`Result: ${result}, memory: ${JSON.stringify(Memory.flags[result])}`);
		return result;
	}

	/**
	 * Returns whether a directive of this type is present either at this position or within the room
	 */
	static isPresent(pos: RoomPosition, scope: 'room' | 'pos'): boolean {
		const room = Game.rooms[pos.roomName] as Room | undefined;
		switch (scope) {
			case 'room':
				if (room) {
					return _.filter(room.flags,
									flag => this.filter(flag) &&
											!(flag.memory.setPos
											&& flag.memory.setPos.roomName != pos.roomName)).length > 0;
				} else {
					const flagsInRoom = _.filter(Game.flags,
												 flag => (flag.memory.setPos || flag.pos).roomName == pos.roomName);
					return _.filter(flagsInRoom, flag => this.filter(flag)).length > 0;
				}
			case 'pos':
				if (room) {
					return _.filter(pos.lookFor(LOOK_FLAGS),
									flag => this.filter(flag) &&
											!(flag.memory.setPos
											&& !equalXYR(pos, flag.memory.setPos))).length > 0;
				} else {
					const flagsAtPos = _.filter(Game.flags, function(flag) {
						if (flag.memory.setPos) { // does it need to be relocated?
							return equalXYR(flag.memory.setPos, pos);
						} else { // properly located
							return equalXYR(flag.pos, pos);
						}
					});
					return _.filter(flagsAtPos, flag => this.filter(flag)).length > 0;
				}
		}
	}

	/**
	 * Create a directive if one of the same type is not already present (in room | at position).
	 * Calling this method on positions in invisible rooms can be expensive and should be used sparingly.
	 */
	static createIfNotPresent(pos: RoomPosition, scope: 'room' | 'pos',
							  opts: DirectiveCreationOptions = {}): number | string | undefined {
		if (this.isPresent(pos, scope)) {
			return; // do nothing if flag is already here
		}

		const room = Game.rooms[pos.roomName] as Room | undefined;
		if (!room) {
			if (!opts.memory) {
				opts.memory = {};
			}
			opts.memory.setPos = pos;
		}
		switch (scope) {
			case 'room':
				if (room) {
					return this.create(pos, opts);
				} else {
					log.info(`Creating directive at ${pos.print}... ` +
							 `No visibility in room; directive will be relocated on next tick.`);
					let createAtPos: RoomPosition;
					if (opts.memory && opts.memory[MEM.COLONY]) {
						createAtPos = Pathing.findPathablePosition(opts.memory[MEM.COLONY]!);
					} else {
						createAtPos = Pathing.findPathablePosition(_.first(getAllColonies()).room.name);
					}
					return this.create(createAtPos, opts);
				}
			case 'pos':
				if (room) {
					return this.create(pos, opts);
				} else {
					log.info(`Creating directive at ${pos.print}... ` +
							 `No visibility in room; directive will be relocated on next tick.`);
					let createAtPos: RoomPosition;
					if (opts.memory && opts.memory[MEM.COLONY]) {
						createAtPos = Pathing.findPathablePosition(opts.memory[MEM.COLONY]!);
					} else {
						createAtPos = Pathing.findPathablePosition(_.first(getAllColonies()).room.name);
					}
					return this.create(createAtPos, opts);
				}
		}
	}

	/* Filter for _.filter() that checks if a flag is of the matching type */
	static filter(flag: Flag): boolean {
		return flag.color == this.color && flag.secondaryColor == this.secondaryColor;
	}

	/* Map a list of flags to directives, accepting a filter */
	static find(flags: Flag[]): Directive[] {
		flags = _.filter(flags, flag => this.filter(flag));
		return _.compact(_.map(flags, flag => Overmind.directives[flag.name]));
	}


	// /**
	//  * Directive.creation() should contain any necessary logic for creating the directive (if the directive is
	//  * automatically placeable); this gets called for every type of directive every tick.
	//  */
	// static creation(): void {
	//
	// }

	/**
	 * Directive.spawnMoarOverlords contains all calls to instantiate overlords on the directive instance
	 */
	abstract spawnMoarOverlords(): void;

	/**
	 * Init() phase logic for the directive goes here and is called in overseer.init()
	 */
	abstract init(): void;

	/**
	 * Run() phase logic for the directive goes here and is called in overseer.run()
	 */
	abstract run(): void;

	// /**
	//  * Directive.removal() should contain any necessary logic for removing the directive.
	//  */
	// removal(): void {
	//
	// }

	/**
	 * Override Directive.visuals() to display any relevant information via room visuals
	 */
	visuals(): void {

	}
}
