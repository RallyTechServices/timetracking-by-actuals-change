Ext.define("TSTimeTrackingByActualsChange", {
    extend: 'Rally.app.App',
    componentCls: 'app',
    logger: new Rally.technicalservices.Logger(),
    defaults: { margin: 10 },
    layout: { type: 'border' }, 
    
    feature_path: 'PortfolioItem/Feature',
    epic_path: 'PortfolioItem/Epic',
    
    items: [
        {xtype:'container',itemId:'selector_box', region: 'north', layout: { type: 'hbox' }},
        {xtype:'container',itemId:'display_box', region: 'center', layout: { type: 'fit' } }
    ],
    
    start_date: null,
    end_date  : null,
    
    config: {
        defaultSettings: {
            typeField: 'State',
            productField: 'c_Driver'
        }
    },
    
    launch: function() {
        var me = this;
        this._getPortfolioItemNames().then({
            scope: this,
            success: function(types) {
                this.feature_path = types[0].get('TypePath');
                this.epic_path = types[1].get('TypePath');
                
                this._addSelectors(this.down('#selector_box'));
            }
        });
    },
    
    _addSelectors: function(container) {
        container.removeAll();
        
        var date_container = container.add({ xtype:'container', layout: { type:'vbox' } });
        var spacer = container.add({ xtype: 'container', flex: 1});
        var right_container = container.add({xtype:'container'});
        
        date_container.add({
            xtype:'rallydatefield',
            itemId:'start_date_selector',
            fieldLabel: 'Start:',
            labelWidth: 45,
            stateful: true,
            stateId: 'rally_techservices_timebychange_start',
            stateEvents: ['change'],
            listeners: { 
                scope: this,
                change: function(db) {
                    this.start_date = db.getValue();
                }
            }
        });
        
        date_container.add({
            xtype:'rallydatefield',
            itemId:'end_date_selector',
            fieldLabel: 'End:',
            labelWidth: 45,
            stateful: true,
            stateId: 'rally_techservices_timebychange_end',
            stateEvents: ['change'],
            listeners: { 
                scope: this,
                change: function(db) {
                    this.end_date = db.getValue();
                    
                }
            }
        });
        
        date_container.add({
            xtype:'rallybutton',
            itemId:'update_button',
            text: '<span class="icon-snapshot"> </span>',
            disabled: false,
            listeners: {
                scope: this,
                click: function() {
                    this._updateData();
                }
            }
        });

        right_container.add({
            xtype:'rallybutton',
            itemId:'export_button',
            text: '<span class="icon-export"> </span>',
            disabled: true,
            listeners: {
                scope: this,
                click: function() {
                    this._export();
                }
            }
        });
    },
    
    _updateData: function() {
        var me = this;
        this.logger.log('updateData');

        if ( this._hasNeededDates() ) {
            this.down('#display_box').removeAll();

            var start_date = Rally.util.DateTime.toIsoString(this.start_date);
            var end_date =   Rally.util.DateTime.toIsoString(this.end_date);
            
            if ( end_date < start_date ) {
                var holder = end_date;
                end_date = start_date;
                start_date = holder;
            }
            
            this.setLoading("Loading actuals...");

            this._getTasksThatChanged(start_date, end_date).then({
                scope: this,
                failure: function(msg) {
                    this.setLoading(false);
                    Ext.Msg.alert("Problem loading Actuals", msg);
                },
                
                success: function(snaps) {
                    this.down('#display_box').removeAll();
                    
                    if ( snaps.length === 0 ) {
                        this.down('#display_box').add({
                            xtype:'container',
                            html :'No changes found'
                        });
                        Rally.getApp().setLoading(false);
                        return;
                    }

                    Rally.getApp().setLoading("Gathering current information...");

                    var rows = this._getTasksFromSnaps(snaps);

                    Deft.Chain.pipeline([
                        function() { return this._findCurrentTaskValues(rows); },
                        function(rows) { return this._setDefectsByOID(rows); }
                    ],this).then({
                        scope: this,
                        success: function(rows) {
                            
                            Rally.getApp().setLoading("Gathering related information...");
                            Deft.Chain.sequence([
                                function() { return this._getStoriesByOID(rows); },
                                function() { return this._getOwnersByOID(rows); }
                            ],this).then({
                                scope: this,
                                success: function(results) {
                                    var stories_by_oid = results[0];
                                    var users_by_oid   = results[1];
                                    this.setLoading('Calculating...');
                                    
                                    this._updateEpicInformation(rows,stories_by_oid);
                                    this._updateOwnerInformation(rows,users_by_oid);
                                    
                                    Deft.Chain.pipeline([
                                        function() {      return this._findMissingData(rows,stories_by_oid); },
                                        function(rows) {  return this._getThemeDataFromRows(rows); }
                                    ],this).then({
                                        scope: this,
                                        success: function(rows) {                                    
                                            this._addGrid(rows); 
                                            this.setLoading(false);
                                        },
                                        failure: function(msg) {
                                            this.setLoading(false);
                                            Ext.Msg.alert('Problem loading ancillary data',msg);
                                        }
                                    });
                                },
                                failure: function(msg) {
                                    this.setLoading(false);
                                    Ext.Msg.alert("Problem loading ancillary data", msg);
                                }
                            
                            });
                        }
                    });
                }
            });
        }
    },
    
    _hasNeededDates: function() {
        return ( this.start_date && this.end_date );
    },
    
    _getTasksThatChanged: function(start_date,end_date) {
        this.logger.log("_getTasksThatChanged", start_date, end_date);
        
        var config = {
            filters: [
                {property:'_TypeHierarchy', value:'Task'},
                {property:'_ValidFrom',operator: '>=', value: start_date},
                {property:'_ValidFrom',operator: '<=', value: end_date},
                {property:'Actuals',operator:'>',value: 0},
                {property:'_ProjectHierarchy', operator:'in', value: [this.getContext().getProject().ObjectID]},
                {property:'_PreviousValues.Actuals', operator: 'exists', value: true}
            ],
            fetch: ['_PreviousValues.Actuals','FormattedID','Owner','Actuals','Name','WorkProduct', this.getSetting('typeField'), '_User'],
            sorters: [{property:'_ValidFrom',direction:'ASC'}],
            limit: 'Infinity'
        };
        return this._loadSnapshots(config);
        
    },
    
    _getTasksFromSnaps: function(snaps) {
        this.logger.log("_getTasksFromSnaps",snaps);
        var row_hash = {};
        Ext.Array.each(snaps, function(snap){
            var oid = snap.get('ObjectID');
            var old_value = snap.get('_PreviousValues.Actuals');
            var new_value = snap.get('Actuals');
            var delta = new_value - old_value;
            if ( !row_hash[oid] ) { 
                row_hash[oid] = {
                    __delta: 0
                };
            }
            row_hash[oid].__delta = row_hash[oid].__delta + delta;
            // apply the most current values of the records to the row
            Ext.apply(row_hash[oid], snap.getData());
        },this);
        
        return Ext.Object.getValues(row_hash);
    },
    
    _getStoriesByOID: function(rows) {
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        var workproducts = Ext.Array.pluck(rows,'WorkProduct');
        var unique_workproducts = Ext.Array.unique(workproducts);
                
        var filter_array = Ext.Array.map(unique_workproducts, function(wp) {
            return { property: 'ObjectID', value: wp };
        });
        
        this.logger.log("# of stories to fetch:", unique_workproducts.length);
        
        var chunk_size = 1000;
        var array_of_filters = [];
        while (filter_array.length > 0) {
            array_of_filters.push(filter_array.splice(0, chunk_size));
        }
            
        var promises = [];
        Ext.Array.each(array_of_filters,function(filters) {
            promises.push( function() {
                var config = {
                    filters: Rally.data.wsapi.Filter.or(filters),
                    model  : 'HierarchicalRequirement',
                    limit  : Infinity,
                    fetch  : ['FormattedID','Name','Feature','Parent',me.getSetting('productField'),'Iteration','c_WorkType'],
                    pageSize: 1000
                };
                return me._loadWSAPIItems(config);
            });
        });
        
        
        Deft.Chain.sequence(promises,this).then({
            success: function(stories) {
                var stories_by_oid = {};
                Ext.Array.each(Ext.Array.flatten(stories), function(story){
                    stories_by_oid[story.get('ObjectID')] = story;
                });
                deferred.resolve(stories_by_oid);
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        return deferred.promise;
    },
    
    _setDefectsByOID: function(rows) {
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        var workproducts = Ext.Array.pluck(rows,'WorkProduct');
        var unique_workproducts = Ext.Array.unique(workproducts);

        var filter_array = Ext.Array.map(unique_workproducts, function(wp) {
            return { property: 'ObjectID', value: wp };
        });
        
        this.logger.log("# of defects to fetch:", unique_workproducts.length);
        
        var chunk_size = 100;
        var array_of_filters = [];
        while (filter_array.length > 0) {
            array_of_filters.push(filter_array.splice(0, chunk_size));
        }
            
        var promises = [];
        Ext.Array.each(array_of_filters,function(filters) {
            promises.push( function() {
                var config = {
                    filters: Rally.data.wsapi.Filter.or(filters),
                    model  : 'Defect',
                    limit  : Infinity,
                    fetch  : ['FormattedID','ObjectID','Name','Feature','Parent',me.getSetting('productField'),'Iteration','c_WorkType','Requirement']
                };
                return me._loadWSAPIItems(config);
            });
        });
        
        Deft.Chain.sequence(promises,this).then({
            success: function(defects) {
                var defects_by_oid = {};
                Ext.Array.each(Ext.Array.flatten(defects), function(defect){
                    defects_by_oid[defect.get('ObjectID')] = defect;
                });
                
                Ext.Array.each(rows, function(row) {
                    var wp_oid = row.WorkProduct;
                    if ( ! Ext.isEmpty(defects_by_oid[wp_oid]) ) {
                        row.__Defect = defects_by_oid[wp_oid].getData();
                        if ( row.__Defect.Requirement && row.__Defect.Requirement.ObjectID ) {
                            row.WorkProduct = row.__Defect.Requirement.ObjectID;
                        }
                    }
                
                });
                deferred.resolve(rows);
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        return deferred.promise;
    },
    
    _getOwnersByOID: function(rows) {
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        var owners = Ext.Array.pluck(rows,'_User');
        var unique_owners = Ext.Array.unique(owners);
        this.logger.log("# of owners to fetch:", unique_owners.length);

        var filter_array = Ext.Array.map(unique_owners, function(owner) {
            return { property: 'ObjectID', value: owner };
        });
        
        var chunk_size = 100;
        var array_of_filters = [];
        while (filter_array.length > 0) {
            array_of_filters.push(filter_array.splice(0, chunk_size));
        }
            
        var promises = [];
        Ext.Array.each(array_of_filters,function(filters) {
            promises.push( function() {
                var config = {
                    filters: Rally.data.wsapi.Filter.or(filters),
                    model  : 'User',
                    limit  : Infinity,
                    fetch  : ['UserName','CostCenter','OfficeLocation','Department','Role']
                };
                return me._loadWSAPIItems(config);
            });
        });
        
        
        Deft.Chain.sequence(promises,this).then({
            success: function(users) {
                var users_by_oid = {};
                Ext.Array.each(Ext.Array.flatten(users), function(user){
                    users_by_oid[user.get('ObjectID')] = user;
                });
                deferred.resolve(users_by_oid);
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        return deferred.promise;
    },
    
    _getThemeDataFromRows: function(rows) {
        var deferred = Ext.create('Deft.Deferred');
        this.logger.log('_getThemeDataFromRows');
        
        var epic_fids = Ext.Array.pluck(rows, '__epic');
        var unique_epic_fids = Ext.Array.unique(epic_fids);
        
        var filters = Ext.Array.map(unique_epic_fids, function(epic_fid){
            return { property:'FormattedID', value:epic_fid };
        });
        
        if ( filters.length === 0 ) {
            filters = [{property:'ObjectID',value:-1}]; // to deal with deferred even if we don't have to query
        }
        
        var config = {
            filters: Rally.data.wsapi.Filter.or(filters),
            model  : this.epic_path,
            limit  : Infinity,
            context: { project: null },
            fetch  : ['FormattedID','Name','Parent']
        };
        
        this._loadWSAPIItems(config).then({
            success: function(epics) {
                var epics_by_fid = {};
                Ext.Array.each(epics, function(epic){
                    epics_by_fid[epic.get('FormattedID')] = epic;
                });
                                
                Ext.Array.each(rows, function(row) {
                    var epic_id = row.__epic;

                    row.__epic_name = "--";
                    row.__theme = "--";
                    row.__theme_name = "--";
                    
                    if ( !Ext.isEmpty(epic_id) ) {
                        var epic = epics_by_fid[epic_id];

                        //if ( epic && epic.get('Parent') ) {
                        if ( epic ) {
                            row.__epic_name = epic.get('Name');
                            if ( epic.get('Parent') ) {
                            row.__theme = epic.get('Parent').FormattedID;
                            row.__theme_name = epic.get('Parent').Name;
                            }
                        }
                    } 
                     
                });
                deferred.resolve(rows);
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        return deferred;
    },
    
    _findCurrentTaskValues: function(rows) {
        // snapshots from lookback have the value of fields at the time the 
        // snap was taken
        this.logger.log('_findCurrentTaskValues',rows.length);
        var deferred = Ext.create('Deft.Deferred');
        this.setLoading('Fetching current task data...');

        var me = this;
        var project_field = this.getSetting('typeField');
        
        var rows_by_oid = {};
        Ext.Array.each(rows, function(row) {
            rows_by_oid[row.ObjectID] = row;
        });
        
        var task_oids = Ext.Array.pluck(rows,'ObjectID');
        
        this.logger.log("# of tasks to fetch:", task_oids.length);
        
        var filter_array = task_oids;
        
        var chunk_size = 300;
        if ( !this.isExternal() ) {
            chunk_size = 1000;
        }
        var array_for_filters = [];
        while (filter_array.length > 0) {
            array_for_filters.push(filter_array.splice(0, chunk_size));
        }
        
            
        var promises = [];
        Ext.Array.each(array_for_filters,function(filters) {
            //var filters: Rally.data.wsapi.Filter.or(filters),
            var filters = [
                {property:'_TypeHierarchy', value:'Task'},
                {property:'ObjectID',operator:'in',value:filters},
                {property: '__At',value: 'current'}
            ];
            
            promises.push( function() {
                var config = {
                    filters: filters,
                    fetch  : ['Name',project_field,'WorkProduct'],
                    useHttpPost: true
                };
                return me._loadSnapshots(config);
            });
        });
        
        
        Deft.Chain.sequence(promises,this).then({
            success: function(tasks) {
                Ext.Array.each(Ext.Array.flatten(tasks), function(task){
                    Ext.apply(rows_by_oid[task.get('ObjectID')], task.getData());
                });
                
                var found_tasks_by_oid = {};
                Ext.Array.each(Ext.Array.flatten(tasks), function(task) { found_tasks_by_oid[task.get('ObjectID')] = task; });
                
                Ext.Array.each(rows, function(row) {
                    var oid = row.ObjectID;
                     
                    if ( Ext.isEmpty(found_tasks_by_oid[oid]) ) {
                        row.__Deleted = true;
                    } else {
                        row.__Deleted = false;
                    }
                });
                
                deferred.resolve(Ext.Object.getValues(rows_by_oid));
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        
        return deferred.promise;
    },
    
    _findMissingData: function(rows, stories_by_oid) {
        this.logger.log('_findMissingData',rows.length);
        // sometimes the data seems to lose its connection to its feature or to the epic above it
        var deferred = Ext.create('Deft.Deferred');
        this.setLoading('Fetching missing data elements...');

        // get the stories that we don't have the epics for
        var features_missing_epics = [];
        
        Ext.Array.each(rows, function(row) {
            var wp_oid = row.WorkProduct;
            var story = stories_by_oid[wp_oid];

            if ( story && story.get('Feature') ) {
                var feature_id = story.get('Feature').FormattedID;
                row.__featureID = feature_id;
                
                if ( row.__epic == "--" ) {
                    features_missing_epics.push(feature_id);
                }
                
            }
        });
        
        features_missing_epics = Ext.Array.unique(features_missing_epics);
        var filters = Ext.Array.map(features_missing_epics, function(feature_fid){
            return { property:'FormattedID', value:feature_fid };
        });
        
        if ( filters.length === 0 ) {
            filters = [{property:'ObjectID',value:-1}]; // to deal with deferred even if we don't have to query
        }
        
        var config = {
            filters: Rally.data.wsapi.Filter.or(filters),
            model  : this.feature_path,
            limit  : Infinity,
            context: { project: null },
            fetch  : ['FormattedID','Name','Parent',this.getSetting('productField')]
        };
        
        this._loadWSAPIItems(config).then({
            success: function(features) {
                var features_by_fid = {};
                Ext.Array.each(features, function(feature){
                    features_by_fid[feature.get('FormattedID')] = feature;
                });
                
                Ext.Array.each(rows, function(row) {
                    
                    var feature_id = row.__featureID;

                    if ( !Ext.isEmpty(feature_id) ) {
                        var feature = features_by_fid[feature_id];

                        if ( feature && feature.get('Parent') ) {
                            row.__epic = feature.get('Parent').FormattedID;
                    
                            var product = feature.get('Parent')[Rally.getApp().getSetting('productField')];
                            if ( Ext.isEmpty(product) ) {
                                product = '--';
                            }
                            row.__epic_product = product;
                        }
                    } 
                     
                });
                deferred.resolve(rows);
            },
            failure: function(msg) {
                deferred.reject(msg);
            }
        });
        
        return deferred.promise;
    },
    
    _updateEpicInformation: function(rows,stories_by_oid) {
        this.logger.log('_updateEpicInformation', rows);
        Ext.Array.each(rows, function(row){
            var wp_oid = row.WorkProduct;
            var story = stories_by_oid[wp_oid];
            var defect = row.__Defect;
            
            if(story){
                story = story.getData();
            }
            
            // default values:
            row.__epic = "--";
            row.__epic_product = '--';
            row.__story = '--';
            row.__story_name = '--';
            row.__story_type = "--";
            row.__iteration = "--";
            
            if ( story ) {
                row.__story_name = story.Name;
                row.__story = story.FormattedID;
                row.__story_type = story.c_WorkType;
                
                if(Ext.isEmpty(defect) && story && story.Iteration)
                {
                    row.__iteration = story.Iteration.Name;
                }
                if ( defect && defect.Iteration ) {
                    row.__iteration = defect.Iteration.Name;
                }
                
                if (story && story.Feature && story.Feature.Parent) {
                    row.__epic = story.Feature.Parent.FormattedID;
                    var product = story.Feature.Parent[this.getSetting('productField')];

                    if ( Ext.isEmpty(product) ) {
                        product = '--';
                    }
                    row.__epic_product = product;
                } else if  ( story.Parent && story.Parent.Feature && story.Parent.Feature.Parent ) {
                    row.__epic = story.Parent.Feature.Parent.FormattedID
                    var product = story.Parent.Feature.Parent[this.getSetting('productField')];
                    if ( Ext.isEmpty(product) ) {
                        product = '--';
                    }
                    row.__epic_product = product;
                } else if ( story.Parent && story.Parent.Feature ) {
                    var product = story.Parent.Feature[this.getSetting('productField')];
                    if ( story.Iteration ) {
                        row.__iteration = story.Iteration.Name;
                    }
                    
                    if ( Ext.isEmpty(product) ) {
                        product = "--";
                    }
                    
                    row.__epic_product = product;
                }
                
            }
        },this);
    },
    
    _updateOwnerInformation: function(rows,users_by_oid) {
        this.logger.log('_updateOwnerInformation');
        
        Ext.Array.each(rows, function(row){
            var owner_oid = row._User;
            var owner = users_by_oid[owner_oid];

            row.__owner = owner;
                        
            if (owner) {
                row.__owner_cost_center = owner.get('CostCenter');
                row.__owner_role = owner.get('Role');
                row.__owner_department = owner.get('Department');
                row.__owner_location = owner.get('OfficeLocation');
            } else {
                row.__owner_cost_center = '';
                row.__owner_department = '';
                row.__owner_location = '';
                row.__owner_role = '';
            }

        },this);
    },
    
    _loadSnapshots: function(config) {
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        this.logger.log("Starting snapshot load", config.filters);
        
        var default_config = {
            fetch: ['ObjectID'],
            removeUnauthorizedSnapshots: true
        };
        
        Ext.create('Rally.data.lookback.SnapshotStore', Ext.merge(default_config,config)).load({
            callback : function(records, operation, successful) {
                if (successful){
                    deferred.resolve(records);
                } else {
                    me.logger.log("Failed: ", operation);
                    deferred.reject('Problem loading: ' + operation.error.errors.join('. '));
                }
            }
        });
        return deferred.promise;
    },
    
    _loadWSAPIItems: function(config){
        var deferred = Ext.create('Deft.Deferred');
        var me = this;
        
        this.logger.log(config.model, "Loading with filters: ", Ext.clone(config.filters));
        
        var default_config = {
            fetch: ['ObjectID'],
            enablePostGet: true
        };
        
        Ext.create('Rally.data.wsapi.Store', Ext.merge(default_config,config)).load({
            callback : function(records, operation, successful) {
                if (successful){
                    deferred.resolve(records);
                } else {
                    me.logger.log("Failed: ", operation);
                    deferred.reject('Problem loading: ' + operation.error.errors.join('. '));
                }
            }
        });
        return deferred.promise;
    },
    
    _addGrid: function(rows){
        this.logger.log('_addGrid', rows);
        
        this.down('#display_box').removeAll();
        var store = Ext.create('Rally.data.custom.Store',{
            data:rows
        });
        
        this.down('#display_box').add({
            xtype:'rallygrid',
            store: store,
            showPagingToolbar: true,
            columnCfgs: [
                {dataIndex:'FormattedID', text:'Task Number', renderer: function(value, meta, record) {
                    var url = Rally.nav.Manager.getDetailUrl( '/task/' + record.get('ObjectID') );
                    if ( record.get('__Deleted') ) { 
                        return value + " (del)";
                    }
                    return Ext.String.format("<a href={0} target='_blank'>{1}</a>", url, value);
                }, _csvIgnoreRender: true},
                {dataIndex: this.getSetting('typeField'), text: 'Task Type' , renderer:function(value,meta,record){
                    if(!Ext.isEmpty(value)){
                        return value;
                    }
                    return record.get("__story_type");
                }
                },
                {dataIndex:'__owner', text:'Owner', renderer: function(v) {
                    if ( Ext.isEmpty(v) ) {
                        return "--";
                    }
                    return v.get('_refObjectName');
                }},
                //{dataIndex:'__owner_cost_center', text:'Cost Center' },
                {dataIndex:'__owner_department', text:'Department' },
                {dataIndex:'__owner_location', text:'Office Location' },
                {dataIndex:'__owner_role', text:'Role' },

                {dataIndex:'__delta', text:'Actual Time'},
                {dataIndex: '__epic_product', text:'Product' },
                {dataIndex:'__story', text: 'Story ID' },
                {dataIndex:'__story_name', text: 'Story Name'},
                {dataIndex:'__iteration', text: 'Sprint'},
                {dataIndex:'__epic', text: 'Epic ID'},
                {dataIndex:'__epic_name', text: 'Epic Name'},
                {dataIndex:'__theme', text:'Theme ID'},
                {dataIndex:'__theme_name', text: 'Theme Name'}
            ],
            listeners: {
                scope: this,
                viewready: function() {
                    this.down('#export_button') && this.down('#export_button').setDisabled(false);
                },
                destroy: function() {
                    this.down('#export_button') && this.down('#export_button').setDisabled(true);
                }
            }
        });
    },
    
    _export: function(){
        var grid = this.down('rallygrid');
        var me = this;
        
        if ( !grid ) { return; }
        
        this.logger.log('_export',grid);

        var filename = Ext.String.format('task-report.csv');

        this.setLoading("Generating CSV");
        Deft.Chain.sequence([
            function() { return Rally.technicalservices.FileUtilities.getCSVFromGrid(this,grid) } 
        ]).then({
            scope: this,
            success: function(csv){
                if (csv && csv.length > 0){
                    Rally.technicalservices.FileUtilities.saveCSVToFile(csv,filename);
                } else {
                    Rally.ui.notify.Notifier.showWarning({message: 'No data to export'});
                }
                
            }
        }).always(function() { me.setLoading(false); });
    },
    
    _getPortfolioItemNames: function() {
        var config = {
            model: 'TypeDefinition', 
            fetch: ["TypePath","Ordinal"],
            filters: [{property:'TypePath', operator:'contains', value:'PortfolioItem/'}],
            sorters: [{property:'Ordinal',direction:'ASC'}]
        };
        
        return this._loadWSAPIItems(config);
    },
    
    getOptions: function() {
        return [
            {
                text: 'About...',
                handler: this._launchInfo,
                scope: this
            }
        ];
    },
    
    _launchInfo: function() {
        if ( this.about_dialog ) { this.about_dialog.destroy(); }
        this.about_dialog = Ext.create('Rally.technicalservices.InfoLink',{});
    },
    
    isExternal: function(){
        return typeof(this.getAppId()) == 'undefined';
    },
    
    //onSettingsUpdate:  Override
    onSettingsUpdate: function (settings){
        this.logger.log('onSettingsUpdate',settings);
        // Ext.apply(this, settings);
        this.launch();
    },
    
    _filterOutExceptChoices: function(store) {
        var app = Rally.getApp();
        app.logger.log('_filterOutExceptChoices');
        
        store.filter([{
            filterFn:function(field){                 
                var attribute_definition = field.get('fieldDefinition').attributeDefinition;
                var attribute_type = null;
                if ( attribute_definition ) {
                    attribute_type = attribute_definition.AttributeType;
                }
                if (  attribute_type == "BOOLEAN" ) {
                    return true;
                }
                if ( attribute_type == "STRING" || attribute_type == "State" ) {
                    if ( field.get('fieldDefinition').attributeDefinition.Constrained ) {
                        return true;
                    }
                }
                return false;
            } 
        }]);
    },
    
    getSettingsFields: function() {
        var me = this;
        
        return [{
            name: 'typeField',
            xtype: 'rallyfieldcombobox',
            fieldLabel: 'Task Type Field',
            labelWidth: 85,
            width: 250,
            margin: 10,
            model: 'Task',
            listeners: {
                ready: function(field_box) {
                    me._filterOutExceptChoices(field_box.getStore());
                }
            },
            //readyEvent: 'ready'
        },
        {
            name: 'productField',
            xtype: 'rallyfieldcombobox',
            fieldLabel: 'Product Field',
            labelWidth: 85,
            width: 250,
            margin: '10 10 175 10',
            model: 'PortfolioItem',
            listeners: {
                ready: function(field_box) {
                    me._filterOutExceptChoices(field_box.getStore());
                }
            },
            //readyEvent: 'ready'
        }];
    }
});